import {
	FrontMatterInfo,
	getFrontMatterInfo,
	MarkdownView,
	normalizePath,
	Notice,
	Plugin,
	requestUrl,
	TFile,
	type TAbstractFile
} from 'obsidian';
import * as xml2js from 'xml2js';
import Fuse, { type FuseResult } from 'fuse.js';
import FuzzySet from 'fuzzyset';

const PEOPLE_DIR = 'People';
const CONF_PAPER_DIR = 'Papers/Conference';
const JOURNAL_PAPER_DIR = 'Papers/Journal';
const INFORMAL_PAPER_DIR = 'Papers/Informal';
const ORG_DIR = 'Organizations';

const DBLP_BASE_PID = 'https://dblp.org/pid';
const DBLP_BASE_PUB = 'https://dblp.dagstuhl.de/rec';

const DBLP_PROPERTY = 'dblp';

interface DblpNote {
	$: {
		type: string,
		label?: string
	},
	_: string
}

interface Person {
	note?: Array<DblpNote> | DblpNote,
	url?: Array<string | { _: string }> | string | { _: string }
}

interface DblpPerson {
	person: Person,
	coauthors?: CoauthorList,
	r: { inproceedings: InProceedings } | { article: Article } | Array<{ inproceedings: InProceedings } | { article: Article }>,
	$: {
		n: number,
		name: string
	}
}

interface CoauthorList {
	$: { n: number },
	co: Array<Coauthor> | Coauthor
}

interface Coauthor {
	$: { n?: number },
	na: Array<{ _: string, $: { pid: string } }> | { _: string, $: { pid: string } }
}

function getCoauthorName(coauthor: Coauthor): string {
	if (Array.isArray(coauthor.na)) {
		return coauthor.na[0]._;
	} else {
		return coauthor.na._;
	}
}

function getCoauthorPid(coauthor: Coauthor): string {
	if (Array.isArray(coauthor.na)) {
		return coauthor.na[0].$.pid;
	} else {
		return coauthor.na.$.pid;
	}
}

interface DblpPersonData {
	dblpperson: DblpPerson
}

interface InProceedings {
	title: string,
	year: string,
	$: { key: string },
	author: Array<{ _: string }> | { _: string },
	booktitle: string
}

function isInProceedings(x: Publication): x is InProceedings {
	return 'booktitle' in x;
}

interface JournalArticle {
	title: string,
	year: string,
	$: { key: string },
	author: Array<{ _: string }> | { _: string },
	journal: string
}

function isJournalArticle(x: Publication): x is JournalArticle {
	return 'journal' in x && '$' in x && !('publtype' in x.$);
}

interface InformalArticle {
	title: string,
	year: string,
	$: {
		key: string,
		publtype: string
	},
	author: Array<{ _: string }> | { _: string },
	journal: string
}

function isInformalArticle(x: Publication): x is InformalArticle {
	return 'journal' in x && '$' in x && 'publtype' in x.$;
}

type Publication = InProceedings | JournalArticle | InformalArticle;
type Article = JournalArticle | InformalArticle;

async function parseXml(xmlString: xml2js.convertableToString): Promise<unknown> {
	return new Promise((resolve, reject): void => {
		xml2js.parseString(
			xmlString,
			{ ignoreAttrs: false, explicitArray: false },
			(err, result): void => {
				if (err) {
					reject(err);
				} else {
					resolve(result);
				}
			}
		);
	});
}

const FORBIDDEN_CHAR_REPLACEMENT = {
	'/': '⁄',
	'\\': '＼',
	':': '﹕',
	';': ';',
	'^': '＾',
	'|': '┃',
	'#': '＃',
	'?': '﹖',
	'~': '～',
	'$': '＄',
	'!': '！',
	'&': '＆',
	'@': '＠',
	'%': '％',
	'"': '＂',
	"'": '＇',
	'<': '＜',
	'>': '＞',
	'{': '｛',
	'}': '｝',
	'[': '［',
	']': '］',
	'*': '＊'
};

function sanitize(fileName: string | { _: string }): string {
	if (typeof fileName !== 'string') {
		fileName = fileName._;
	}
	for (const [key, value] of Object.entries(FORBIDDEN_CHAR_REPLACEMENT)) {
		fileName = fileName.replaceAll(key, value);
	}
	return normalizePath(fileName);
}

function hasProperties(lines: Array<string>): boolean {
	return lines && lines.length > 0 && lines[0] === '---';
}

function exists(property: string, lines: Array<string>): boolean {
	let i = 1;
	while (lines[i] !== '---') {
		if (lines[i].startsWith(`${property}:`)) {
			return true;
		}
		i++;
	}
	return false;
}

const EXCEPTION_PREFIXES: Array<string> = [
	'University of California,'
];

function sliceAtFirstComma(text: string): string {

	for (const exceptionPrefix of EXCEPTION_PREFIXES) {
		if (text.startsWith(exceptionPrefix)) {
			const suffix: string = text.slice(exceptionPrefix.length);
			const index: number = suffix.indexOf(',');
			if (index >= 0) {
				return text.slice(0, exceptionPrefix.length + index);
			}
			return text;
		}
	}

	const index: number = text.indexOf(',');
	if (index >= 0) {
		return text.slice(0, index);
	}
	return text;
}

// Main plugin class
export default class DblpFetchPlugin extends Plugin {

	async onload(): Promise<void> {
		this.addCommand({
			id: 'dblp-fetch',
			name: 'DBLP Fetch',
			checkCallback: (checking: boolean): boolean => {
				const view: MarkdownView | null = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) {
					const mdContent: string = view.getViewData();
					const dblpProperty: string | undefined = mdContent.split('\n').find(
						(line: string): boolean => line.startsWith(`${DBLP_PROPERTY}: `)
					);
					if (dblpProperty) {
						const dblpUrl: string = dblpProperty.substring(6).trim();
						if (!checking && view.file) {
							this.fetch(dblpUrl, view.file);
						}
						return true;
					}
				}
				return false;
			}
		});
	}

	async onunload(): Promise<void> { }

	private async createFile(path: string, content: string): Promise<boolean> {
		try {
			await this.app.vault.create(path, content);
			return true;
		} catch (e) {
			return false;
		}
	}

	private async createPublicationMdFiles(queued: Array<Publication>): Promise<void> {

		for (const pub of queued) {
			const title: string = sanitize(pub.title);
			const year: string = pub.year;
			const key: string = pub.$.key.trim();

			const citation: string = await requestUrl(`${DBLP_BASE_PUB}/${pub.$.key}.bib`).text;
			let authors: Array<string>;
			if (Array.isArray(pub.author)) {
				authors = pub.author.map(
					(author: { _: string }): string => `author:: [[${author._}]]`
				);
			} else {
				authors = [`author:: [[${pub.author._}]]`];
			}
			const content = `---\nkey: ${key}\n---\n\`\`\`bibtex\n${citation}\`\`\`\n${authors.join('\n')}`;

			let path = '';
			if (isInProceedings(pub)) {
				const venue: string = pub.booktitle.replaceAll(/[^A-Z]/g, '');
				path = `${CONF_PAPER_DIR}/${venue}`;
				try {
					await this.app.vault.createFolder(path);
				} catch { /* empty */ }
				path = `${path}/${year}`;
				try {
					await this.app.vault.createFolder(path);
				} catch { /* empty */ }
			} else if (isJournalArticle(pub)) {
				path = `${JOURNAL_PAPER_DIR}/${pub.journal}`;
				try {
					await this.app.vault.createFolder(path);
				} catch { /* empty */ }
				path = `${path}/${year}`;
				try {
					await this.app.vault.createFolder(path);
				} catch { /* empty */ }
			} else if (isInformalArticle(pub)) {
				path = `${INFORMAL_PAPER_DIR}/${year}`;
				try {
					await this.app.vault.createFolder(path);
				} catch { /* empty */ }
			}

			let filePath = `${path}/${title}.md`;
			let created: boolean = await this.createFile(filePath, content);

			if (!created) {
				const file: TFile | null = this.app.vault.getFileByPath(filePath);
				let fileKey: string | undefined;
				if (file) {
					const fileContents: string = await this.app.vault.cachedRead(file);
					const frontMatterInfo: FrontMatterInfo = getFrontMatterInfo(fileContents);
					fileKey = frontMatterInfo.frontmatter.split(': ')[1].trim();

					if (key !== fileKey) {
						const altTitle: string = sanitize(`${title}(${key})`);
						filePath = sanitize(`${path}/${altTitle}.md`);
						created = await this.createFile(filePath, content);
						if (!created) {
							console.log(`FAILED TO CREATE: ${path}/${title}.md AND ${path}/${title}(${key}).md...\nMOVING ON...`);
						}
					}
				}
			}
		}
	}

	private async populatePublicationNotes(dblpPerson: DblpPerson): Promise<void> {
		new Notice('Creating publication notes...');

		let pubs: Array<Publication> = [];
		if (dblpPerson.$.n == 1) {
			if ('inproceedings' in dblpPerson.r) {
				pubs = [dblpPerson.r.inproceedings as Publication];
			}
			if ('article' in dblpPerson.r) {
				pubs = [dblpPerson.r.article as Publication];
			}
		} else if (Array.isArray(dblpPerson.r)) {
			pubs = dblpPerson.r.map(
				(pub: { inproceedings: InProceedings, article: Article }): Publication => (
					('inproceedings' in pub && pub.inproceedings) || ('article' in pub && pub.article)
				) as Publication
			);
		}

		this.createPublicationMdFiles(pubs);
	}

	private async populateAuthorNotes(dblpPerson: DblpPerson): Promise<void> {
		new Notice('Creating author notes...');

		let coauthors: Array<{ name: string, pid: string }> = [];
		if (dblpPerson.coauthors) {
			const co: Coauthor | Array<Coauthor> = dblpPerson.coauthors.co;
			if (Array.isArray(co)) {
				coauthors = co.map(
					(coauthor: Coauthor): { name: string, pid: string } => ({
						name: getCoauthorName(coauthor),
						pid: getCoauthorPid(coauthor)
					})
				);
			} else {
				coauthors = [{
					name: getCoauthorName(co),
					pid: getCoauthorPid(co)
				}];
			}
		}

		const existingPeople = new Set(
			this.app.vault.getFolderByPath(PEOPLE_DIR)?.children.map(
				(file: TFile): string => file.name
			)
		);

		// Create/update coauthor files
		for (const coauthor of coauthors) {
			const { name, pid } = coauthor;
			const filePath = `${PEOPLE_DIR}/${name}.md`;
			if (existingPeople.has(name)) {
				const file: TFile | null = this.app.vault.getFileByPath(filePath);
				if (file) {
					await this.app.vault.process(file, (content: string): string => {
						let newContent: Array<string> = content.split('\n');
						if (newContent.length > 0) {
							if (hasProperties(newContent) && !exists(DBLP_PROPERTY, newContent)) {
								newContent.splice(1, 0, `dblp: ${DBLP_BASE_PID}/${pid}`);
							} else if (!hasProperties(newContent)) {
								newContent = [
									'---',
									`dblp: ${DBLP_BASE_PID}/${pid}`,
									'---',
									...content
								];
							}
							return newContent.join('\n');
						} else {
							return `---\ndblp: ${DBLP_BASE_PID}/${pid}\n---\n`;
						}
					});
				}
			} else {
				await this.createFile(filePath, `---\ndblp: ${DBLP_BASE_PID}/${pid}\n---\n`);
			}
		}
	}

	private async getAffiliations(dblpPerson: DblpPerson): Promise<Array<string>> {
		const person: Person = dblpPerson.person;
		const dblpAffiliations: Array<string> = [];
		const affiliations: Array<string> = [];

		if (person.note) {
			if (Array.isArray(person.note)) {
				dblpAffiliations.push(
					...person.note.filter(
						(note: DblpNote): boolean => note.$.type === 'affiliation' && !note.$.label
					).map(
						(note: DblpNote): string => sliceAtFirstComma(note._)
					)
				);
			} else if (person.note.$.type === 'affiliation' && !person.note.$.label) {
				dblpAffiliations.push(sliceAtFirstComma(person.note._));
			}

			const orgFiles: Array<TFile> = (this.app.vault.getFolderByPath(ORG_DIR)?.children || []).filter(
				(file: TAbstractFile): file is TFile => file instanceof TFile
			);

			const organizations: Map<string, string> = new Map(
				orgFiles.map((file: TFile): [string, string] => [file.basename, file.basename]) || []
			);

			for (const orgFile of orgFiles) {
				const org: string = orgFile.basename;
				const fileContents: string = await this.app.vault.cachedRead(orgFile);
				const frontMatterInfo: FrontMatterInfo = getFrontMatterInfo(fileContents);
				if (frontMatterInfo.exists) {
					const aliases: Array<string> = frontMatterInfo.frontmatter.split('\n').map(
						(line: string): string => line.trim()
					).filter(
						(line: string): boolean => line.startsWith('-')
					).map(
						(line: string): string => line.slice(1).trim()
					);
					if (aliases) {
						aliases.forEach((alias: string): void => {
							organizations.set(alias, org);
						});
					}
				}
			}

			const fuzzyOrgs: FuzzySet = FuzzySet([...organizations.keys()]);
			const fuse = new Fuse([...organizations.keys()], {
				includeScore: true,
				shouldSort: true
			});

			for (const org of dblpAffiliations) {
				const fuzzyResults: Array<[number, string]> | null = fuzzyOrgs.get(org);
				const fuseResults: Array<FuseResult<string>> = fuse.search(org);
				let affil: string = org;

				// console.log(`FuzzyOrgs: ${fuzzyResults}`);
				// console.log(`Fuse: ${fuseResults.map(result => result.item)}`);

				if (fuzzyResults && fuzzyResults.length && fuseResults && fuseResults.length) {
					const [bestFuzzyScore, bestFuzzyItem] = fuzzyResults[0];
					const { score, item } = fuseResults[0];

					// console.log(`Fuzzy: ${bestFuzzyItem} ${bestFuzzyScore}`);
					// console.log(`Fuse: ${item} ${score}`);

					if (bestFuzzyItem === item && bestFuzzyScore >= 0.75 && score !== undefined && score <= 0.33) {
						affil = organizations.get(item) || affil;
					} else {
						await this.createFile(`${ORG_DIR}/${org}.md`, '');
					}
				} else {
					await this.createFile(`${ORG_DIR}/${org}.md`, '');
				}

				affiliations.push(affil);
			}
		}
		return affiliations;
	}

	private processURL(links: { orcid: string; wikipedia: string; mgp: string; }, url: string): void {
		if (url.includes('orcid.org')) {
			links.orcid = url;
		} else if (url.includes('wikipedia.org')) {
			links.wikipedia = url;
		} else if (url.includes('mathgenealogy.org')) {
			links.mgp = url;
		}
	}

	private getLinks(dblpPerson: DblpPerson): Array<string> {
		const links = { orcid: '', wikipedia: '', mgp: '' };
		const person: Person = dblpPerson.person;
		if (person.url) {
			if (Array.isArray(person.url)) {
				for (const url of person.url) {
					this.processURL(links, typeof url === 'string' ? url : url._);
				}
			} else {
				const url: string | { _: string } = person.url;
				this.processURL(links, typeof url === 'string' ? url : url._);
			}
		}
		return Object.entries(links).filter(
			([, value]: [string, string]): string => value
		).map(
			([key, value]: [string, string]): string => `${key}: ${value}`
		);
	}

	private async fetch(dblpUrl: string, personFile: TFile): Promise<void> {
		// Fetch and parse XML data
		const response: string = await requestUrl(`${dblpUrl}.xml`).text;
		const xmlData: DblpPersonData = await parseXml(response) as DblpPersonData;
		const dblpPerson: DblpPerson = xmlData.dblpperson;
		const name: string = dblpPerson.$.name;


		await this.populatePublicationNotes(dblpPerson);
		new Notice(`Done creating publication notes for ${name}.`);

		await this.populateAuthorNotes(dblpPerson);
		new Notice(`Done creating co-author notes for ${name}.`);

		const affiliations: Array<string> = await this.getAffiliations(dblpPerson);
		let links: Array<string> = this.getLinks(dblpPerson);
		const dateTime = new Date(Date.now());

		await this.app.vault.process(personFile, (data: string): string => {
			links = links.filter((link: string): boolean => !data.includes(link));
			const newData: string = data
				.split('\n')
				.toSpliced(1, 0, ...links)
				.filter(
					(line: string): boolean => !line.startsWith('Last DBLP fetch:') && !line.startsWith('affiliation::')
				).concat(
					affiliations.map((affil: string): string => `affiliation:: [[${affil}]]`)
				).join('\n');
			return `${newData}\n\nLast DBLP fetch: ${dateTime}`.replaceAll(/\n(\n)+/g, '\n\n');
		});

		new Notice(`Done fetching DBLP data for ${name} from ${dblpUrl}.`);
	}
}


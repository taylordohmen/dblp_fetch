import {
	Editor,
	FrontMatterInfo,
	getFrontMatterInfo,
	MarkdownView,
	Notice,
	Plugin,
	requestUrl,
	TFile
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

const CONFERENCE_TYPE = 'conference';
const JOURNAL_TYPE = 'journal';
const INFORMAL_TYPE = 'informal';

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

function sanitize(fileName: string | { _: string; }): string {
	if (typeof fileName !== 'string') {
		fileName = fileName._;
	}
	for (const [key, value] of Object.entries(FORBIDDEN_CHAR_REPLACEMENT)) {
		fileName = fileName.replaceAll(key, value);
	}
	return fileName;
}

function hasProperties(lines: Array<string>): boolean {
	return lines && lines.length > 0 && lines[0] === '---';
}

function dblpExists(lines: Array<string>): boolean {
	let i = 1;
	while (lines[i] !== '---') {
		if (lines[i].startsWith('dblp: ')) {
			return true;
		}
		i++;
	}
	return false;
}

function sliceAtFirstComma(text: string): string {
	const exceptionPrefix = 'University of California,';
	if (text.startsWith(exceptionPrefix)) {
		const suffix: string = text.slice(exceptionPrefix.length);
		const index: number = suffix.indexOf(',');
		if (index >= 0) {
			return text.slice(0, exceptionPrefix.length + index);
		}
		return text;
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
			editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView): boolean => {
				const value: string = editor.getValue();
				if (value) {
					const dblpProperty: string | undefined = value
						.split('\n')
						.find((line: string): boolean => line.startsWith('dblp: '));
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

	private async createPublicationMdFiles(queued: Array<Publication>, type: string): Promise<void> {

		for (const pub of queued) {
			const title: string = sanitize(pub.title);
			const year: string = pub.year;
			const key: string = pub.$.key.trim();

			const citation: string = await requestUrl(`${DBLP_BASE_PUB}/${pub.$.key}.bib`).text;
			let authors: Array<string>;
			if (Array.isArray(pub.author)) {
				authors = pub.author.map((author: { _: string; }): string => `author:: [[${author._}]]`);
			} else {
				authors = [`author:: [[${pub.author._}]]`];
			}
			const content = `---\nkey: ${key}\n---\n\`\`\`bibtex\n${citation}\`\`\`\n${authors.join('\n')}`;

			let path: string;
			if (type === CONFERENCE_TYPE) {
				const venue: string | undefined = pub.booktitle?.replaceAll(/[^A-Z]/g, '');

				path = `${CONF_PAPER_DIR}/${venue}`;
				try {
					await this.app.vault.createFolder(path);
				} catch {
					/* empty */
				}

				path = `${path}/${year}`;
				try {
					await this.app.vault.createFolder(path);
				} catch {
					/* empty */
				}
			} else if (type === JOURNAL_TYPE) {
				path = `${JOURNAL_PAPER_DIR}/${pub.journal}`;
				try {
					await this.app.vault.createFolder(path);
				} catch {
					/* empty */
				}

				path = `${path}/${year}`;
				try {
					await this.app.vault.createFolder(path);
				} catch {
					/* empty */
				}
			} else {
				path = `${INFORMAL_PAPER_DIR}/${year}`;
				try {
					await this.app.vault.createFolder(path);
				} catch {
					/* empty */
				}
			}

			let created: boolean = await this.createFile(`${path}/${title}.md`, content);
			let altTitle: string | undefined;

			if (!created) {
				const file: TFile | null = this.app.vault.getFileByPath(
					`${path}/${title}.md`
				);
				let fileKey: string | undefined;
				if (file) {
					const fileContents: string = await this.app.vault.read(file);
					const frontMatterInfo: FrontMatterInfo = getFrontMatterInfo(fileContents);
					fileKey = frontMatterInfo.frontmatter.split(': ')[1].trim();
				}
				if (key === fileKey) {
					created = true;
				} else {
					altTitle = sanitize(`${title}(${key})`);
					console.log(`ALT TITLE: ${altTitle}`);
					created = await this.createFile(`${path}/${altTitle}.md`, content);
				}
			}
			if (!created) {
				console.log(`FAILED TO CREATE: ${path}/${title}.md AND ${path}/${altTitle}.md`);
				console.log('MOVING ON...');
			}
		}
	}

	private async getAffiliations(dblpPerson): Promise<Array<string>> {
		const person = dblpPerson.person;
		const dblpAffiliations: Array<string> = [];
		const affiliations: Array<string> = [];

		if (person.note) {
			if (Array.isArray(person.note)) {
				dblpAffiliations.push(
					...person.note
						.filter((note): boolean => note.$.type === 'affiliation' && !note.$.label)
						.map((note): string => sliceAtFirstComma(note._))
				);
			} else if (person.note.$.type === 'affiliation' && !person.note.$.label) {
				dblpAffiliations.push(sliceAtFirstComma(person.note._));
			}

			const organizations: Array<string> = this.app.vault
				.getFolderByPath(ORG_DIR)?.children
				.map((file: TFile): string => file.name.slice(0, -3))
				|| [];

			const fuzzyOrgs: FuzzySet = FuzzySet(organizations);
			const fuse = new Fuse(organizations, {
				includeScore: true,
				shouldSort: true
			});

			for (const org of dblpAffiliations) {
				const fuzzyResults: Array<[number, string]> | null = fuzzyOrgs.get(org);
				const fuseResults: Array<FuseResult<string>> = fuse.search(org);
				let affil: string = org;

				if (fuzzyResults && fuzzyResults.length && fuseResults && fuseResults.length) {
					const [bestFuzzyScore, bestFuzzyItem] = fuzzyResults[0];
					const { score, item } = fuseResults[0];

					if (bestFuzzyItem === item && bestFuzzyScore >= 0.75 && score && score <= 0.33) {
						affil = item;
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

	private async populatePublicationNotes(dblpPerson: any): Promise<void> {
		new Notice('Creating publication notes...');

		let pubs;
		if (dblpPerson.$.n == 1) {
			if (dblpPerson.r.inproceedings) {
				pubs = [dblpPerson.r.inproceedings];
			}
			if (dblpPerson.r.article) {
				pubs = [dblpPerson.r.article];
			}
		} else {
			pubs = dblpPerson.r;
		}

		const confPubs = pubs
			.filter((x) => x.inproceedings)
			.map((x) => x.inproceedings);

		const journalPubs = pubs
			.filter((x) => x.article && !x.article.$.publtype)
			.map((x) => x.article);

		const informalPubs = pubs
			.filter((x) => x.article && x.article.$.publtype && x.article.$.publtype === 'informal')
			.map((x) => x.article);

		await this.createPublicationMdFiles(confPubs, CONFERENCE_TYPE);
		await this.createPublicationMdFiles(journalPubs, JOURNAL_TYPE);
		await this.createPublicationMdFiles(informalPubs, INFORMAL_TYPE);
	}

	private async populateAuthorNotes(dblpPerson): Promise<void> {
		new Notice('Creating author notes...');

		let coauthors: Array<{ name: string, pid: string }> = [];
		if (dblpPerson.coauthors && dblpPerson.coauthors.$.n > 1) {
			coauthors = dblpPerson.coauthors.co.map((coauthor): { name: string, pid: string } => {
				if (coauthor.$.n) {
					return { name: coauthor.na[0]._, pid: coauthor.na[0].$.pid };
				} else {
					return { name: coauthor.na._, pid: coauthor.na.$.pid };
				}
			});
		}
		if (dblpPerson.coauthors && dblpPerson.coauthors.$.n == 1) {
			if (dblpPerson.coauthors.co.$.n) {
				coauthors = [
					{ name: dblpPerson.coauthors.co.na[0]._, pid: dblpPerson.coauthors.co.na[0].$.pid }
				];
			} else {
				coauthors = [
					{ name: dblpPerson.coauthors.co.na._, pid: dblpPerson.coauthors.co.na.$.pid }
				];
			}
		}

		const existingPeople = new Set(
			this.app.vault.getFolderByPath(PEOPLE_DIR)?.children.map((file: TFile): string => file.name)
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
							if (hasProperties(newContent) && !dblpExists(newContent)) {
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

	private processURL(links: { orcid: string; wikipedia: string; mgp: string; }, url: string): void {
		if (url.includes('orcid.org')) {
			links.orcid = url;
		} else if (url.includes('wikipedia.org')) {
			links.wikipedia = url;
		} else if (url.includes('mathgenealogy.org')) {
			links.mgp = url;
		}
	}

	private async getLinks(dblpPerson: DblpPerson): Promise<Array<string>> {
		const links = { orcid: '', wikipedia: '', mgp: '' };
		const person = dblpPerson.person;
		if (person.url) {
			if (Array.isArray(person.url)) {
				for (const url of person.url) {
					this.processURL(links, typeof url === 'string' ? url : url._);
				}
			} else {
				const url = person.url;
				this.processURL(links, typeof url === 'string' ? url : url._);
			}
		}
		return Object.entries(links)
			.filter(([, value]: [string, string]): string => value)
			.map(([key, value]: [string, string]): string => `${key}: ${value}`);
	}

	private async fetch(dblpUrl: string, personFile: TFile): Promise<void> {
		// Fetch and parse XML data
		const response: string = await requestUrl(`${dblpUrl}.xml`).text;
		const xmlData: DblpPersonData = await parseXml(response) as DblpPersonData;
		const dblpPerson: DblpPerson = xmlData.dblpperson;

		const affiliations: Array<string> = await this.getAffiliations(dblpPerson);
		let links: Array<string> = await this.getLinks(dblpPerson);
		await this.populatePublicationNotes(dblpPerson);
		await this.populateAuthorNotes(dblpPerson);

		const dateTime = new Date(Date.now());
		await this.app.vault.process(personFile, (data: string): string => {
			links = links.filter((link: string): boolean => !data.includes(link));
			const newData: string = data
				.split('\n')
				.toSpliced(1, 0, ...links)
				.filter((line: string): boolean => !line.startsWith('Last DBLP fetch:'))
				.filter((line:string): boolean => !line.startsWith('affiliation::'))
				.concat(affiliations.map((affil: string): string => `affiliation:: [[${affil}]]`))
				.join('\n');
			return `${newData}\n\nLast DBLP fetch: ${dateTime}`.replaceAll(/\n(\n)+/g, '\n\n');
		});
		new Notice(`Done fetching data from ${dblpUrl}`);
	}
}

interface DblpPerson {
	person: {
		note?: Array<{ $: { type: string, label?: string }, _: string }> | { $: { type: string, label?: string }, _: string },
		url?: Array<string | { _: string }> | string | { _: string }
	},
	coauthors: {
		$: { n: number },
		co: Array<{
			na: Array<{ _: string,$: { pid: string } }> | { _: string, $: { pid: string } }
		}>
	},
	r: Array<{
		inproceedings?: {
			title: string,
			year: string,
			$: { key: string },
			author: Array<{ _: string }> | { _: string },
			booktitle: string 
		}
		article?: {
			title: string,
			year: string,
			$: { key: string, publtype?: string },
			author: Array<{ _: string }> | { _: string },
			journal: string }
	}>,
	$: { n: number }
}

interface DblpPersonData {
	dblpperson: DblpPerson
}

interface Publication {
	title: string,
	year: string,
	$: { key: string },
	author: Array<{ _: string }> | { _: string },
	booktitle?: string,
	journal?: string
}
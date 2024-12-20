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
import Fuse from 'fuse.js';
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
	$: '＄',
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

const parseXml = async (xmlString: xml2js.convertableToString) => {
	return new Promise((resolve, reject) => {
		xml2js.parseString(
			xmlString,
			{ ignoreAttrs: false, explicitArray: false },
			(err, result) => {
				if (err) {
					reject(err);
				} else {
					resolve(result);
				}
			}
		);
	});
};

const sanitize = (fileName: string): string => {
	if (typeof fileName !== 'string') {
		fileName = fileName._;
	}
	for (const [key, value] of Object.entries(FORBIDDEN_CHAR_REPLACEMENT)) {
		fileName = fileName.replaceAll(key, value);
	}
	return fileName;
};

const hasProperties = (lines: Array<string>): boolean => {
	return lines && lines.length > 0 && lines[0] === '---';
};

const dblpExists = (lines: Array<string>): boolean => {
	let i = 1;
	while (lines[i] !== '---') {
		if (lines[i].startsWith('dblp: ')) {
			return true;
		}
		i++;
	}
	return false;
};

const sliceAtFirstComma = (text: string): string => {
	const exceptionPrefix = 'University of California,'; 
	if (text.startsWith(exceptionPrefix)) {
		const suffix = text.slice(exceptionPrefix.length);
		const index = suffix.indexOf(',');
		if (index >= 0) {
			return text.slice(0, exceptionPrefix.length + index);
		}
		return text;
	}

	const index = text.indexOf(',');
	if (index >= 0) {
		return text.slice(0, index);
	}
	return text;
};

// Main plugin class
export default class DblpFetchPlugin extends Plugin {
	async onload() {
		this.addCommand({
			id: 'dblp-fetch',
			name: 'DBLP Fetch',
			editorCheckCallback: async (checking: boolean, editor: Editor, view: MarkdownView) => {
				const value: string = editor.getValue();
				if (value) {
					const dblpProperty: string | undefined = value
						.split('\n')
						.find((line) => line.startsWith('dblp: '));
					if (dblpProperty) {
						const dblpUrl = dblpProperty.substring(6).trim();
						if (!checking) {
							await this.fetch(dblpUrl, view.file);
						}
						return true;
					}
				}
				return false;
			}
		});
	}

	private async createFile(path: string, content: string): Promise<void> {
		try {
			await this.app.vault.create(path, content);
			return true;
		} catch (e) {
			return false;
		}
	}

	private async createPublicationMdFiles(queued: Array<unknown>, type: string): Promise<void> {
		for (const pub of queued) {
			const title: string = sanitize(pub.title);
			const year: string = pub.year;
			const key: string = pub.$.key.trim();

			const citation = await requestUrl(`${DBLP_BASE_PUB}/${pub.$.key}.bib`).text;
			let authors;
			if (pub.author.length) {
				authors = pub.author.map((author) => `author:: [[${author._}]]`);
			} else {
				authors = [`author:: [[${pub.author._}]]`];
			}
			const content = `---\nkey: ${key}\n---\n\`\`\`bibtex\n${citation}\`\`\`\n${authors.join(
				'\n'
			)}`;

			let path: string;
			if (type === CONFERENCE_TYPE) {
				const venue = pub.booktitle.replaceAll(/[^A-Z]/g, '');

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

			let created = await this.createFile(`${path}/${title}.md`, content);
			let altTitle: string;

			if (!created) {
				const file: TFile | null = await this.app.vault.getFileByPath(
					`${path}/${title}.md`
				);
				let fileKey: string;
				if (file) {
					const fileContents: string = await this.app.vault.read(file);
					const frontMatterInfo: FrontMatterInfo = await getFrontMatterInfo(fileContents);
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
		const dblpAffiliations = [];

		if (person.note) {
			if (person.note.length) {
				dblpAffiliations.push(
					...person.note
						.filter((note) => note.$.type === 'affiliation' && !note.$.label)
						.map((note) => sliceAtFirstComma(note._))
				);
			} else if (person.note.$.type === 'affiliation' && !person.note.$.label) {
				dblpAffiliations.push(sliceAtFirstComma(person.note._));
			}
		}

		const organizations = await this.app.vault
			.getFolderByPath(ORG_DIR)
			.children.map((file: TFile) => file.name.slice(0, -3));
		
		const fuzzyOrgs = FuzzySet(organizations);
		const fuse = new Fuse(organizations, {
			includeScore: true,
			shouldSort: true
		});
		const affiliations = [];
		for (const org of dblpAffiliations) {
			const fuzzyResults = fuzzyOrgs.get(org);
			const fuseResults = fuse.search(org);
			let affil = org;

			if (fuzzyResults && fuseResults) {
				const [bestFuzzyScore, bestFuzzyItem] = fuzzyResults[0];
				const {score, item, ...others} = fuseResults[0];
				if (bestFuzzyItem === item && bestFuzzyScore >= 0.75 && score <= 0.33) {
					affil = item;
				} else {
					await this.createFile(`${ORG_DIR}/${org}.md`, '');
				}
			} else {
				await this.createFile(`${ORG_DIR}/${org}.md`, '');
			}
			
			affiliations.push(affil);
		}
		return affiliations;
	}

	private async populatePublicationNotes(dblpPerson): Promise<void> {
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

		const confPubs = pubs.filter((x) => x.inproceedings).map((x) => x.inproceedings);

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

		let coauthors;
		if (dblpPerson.coauthors.$.n > 1) {
			coauthors = dblpPerson.coauthors.co.map((coauthor) => {
				if (coauthor.$.n) {
					return { name: coauthor.na[0]._, pid: coauthor.na[0].$.pid };
				} else {
					return { name: coauthor.na._, pid: coauthor.na.$.pid };
				}
			});
		}
		if (dblpPerson.coauthors.$.n == 1) {
			if (dblpPerson.coauthors.co.$.n) {
				coauthors = [
					{
						name: dblpPerson.coauthors.co.na[0]._,
						pid: dblpPerson.coauthors.co.na[0].$.pid
					}
				];
			} else {
				coauthors = [
					{ name: dblpPerson.coauthors.co.na._, pid: dblpPerson.coauthors.co.na.$.pid }
				];
			}
		}

		const existingPeople = new Set(
			await this.app.vault
				.getFolderByPath(PEOPLE_DIR)
				.children.map((file: TFile) => file.name)
		);

		// Create/update coauthor files
		for (const coauthor of coauthors) {
			const { name, pid } = coauthor;
			const filePath = `${PEOPLE_DIR}/${name}.md`;

			if (existingPeople.has(name)) {
				const file = await this.app.vault.getFileByPath(filePath);

				await this.app.vault.process(file, (content: string) => {
					let newContent = content.split('\n');
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
			} else {
				await this.createFile(filePath, `---\ndblp: ${DBLP_BASE_PID}/${pid}\n---\n`);
			}
		}
	}

	private async fetch(dblpUrl: string, personFile: TFile): Promise<void> {
		// Fetch and parse XML data
		const response: string = await requestUrl(`${dblpUrl}.xml`).text;
		const xmlData = await parseXml(response);
		const dblpPerson = xmlData.dblpperson;

		const affiliations = await this.getAffiliations(dblpPerson);
		await this.populatePublicationNotes(dblpPerson);
		await this.populateAuthorNotes(dblpPerson);

		const dateTime = new Date(Date.now());
		await this.app.vault.process(personFile, (data: string) => {
			const newData = data
				.split('\n')
				.filter(line => !line.startsWith('Last DBLP fetch:'))
				.filter(line => !line.startsWith('affiliation::'))
				.concat(affiliations.map(affil => `affiliation:: [[${affil}]]`))
				.join('\n');
			return `${newData}\n\nLast DBLP fetch: ${dateTime}`.replaceAll(/\n(\n)+/g, '\n\n');
		});
		new Notice(`Done fetching data from ${dblpUrl}`);
	}

	async onunload() {}
}

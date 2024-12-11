import { Editor, FrontMatterInfo, getFrontMatterInfo, MarkdownView, Notice, Plugin, requestUrl, TFile } from 'obsidian';
import * as xml2js from 'xml2js';

const PEOPLE_DIR = 'People';
const CONF_PAPER_DIR = 'Papers/Conference';
const JOURNAL_PAPER_DIR = 'Papers/Journal';
const INFORMAL_PAPER_DIR = 'Papers/Informal';

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
	'\'': '＇',
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
		xml2js.parseString(xmlString, { ignoreAttrs: false, explicitArray: false },
			(err, result) => {
				if (err) { reject(err);	}
				else { resolve(result); }
			}
		);
	});
};

const sanitize = (fileName: string): string => {
	if (typeof fileName !== 'string'){
		fileName = fileName._;
	}
	for (const [key, value] of Object.entries(FORBIDDEN_CHAR_REPLACEMENT)) {
		fileName = fileName.replaceAll(key, value);
	}
	return fileName;
};

const hasProperties = (lines: Array<string>): boolean => lines && lines.length > 0 && lines[0] === '---';

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
						.find(line => line.startsWith('dblp: '));
					if (dblpProperty) {
						const dblpUrl = dblpProperty.substring(6).trim();
						if (!checking) {
							await this.fetch(dblpUrl);
							const dateTime = new Date(Date.now());
							await this.app.vault.process(view.file, (data: string) => {
								const index = data.indexOf('Last DBLP fetch:');
								if (index === -1) {
									return `${data}\n\nLast DBLP fetch: ${dateTime}`;
								}
								return `${data.substring(0, index)}Last DBLP fetch: ${dateTime}`;	
							});
						}
						return true;
					}
				}
				return false;
			}
		});

	}

	private async createFile(path: string, content: string): void {
		try{
			await this.app.vault.create(path, content);
			return true;
		} catch(e) {
			return false;
		}
	}

	private async createPublicationMdFiles(queued: Array<unknown>, type: string): void {
		for (const pub of queued) {
			const title: string = sanitize(pub.title);
			const year: string = pub.year;
			const key: string = pub.$.key.trim();

			const citation = await requestUrl(`${DBLP_BASE_PUB}/${pub.$.key}.bib`).text;
			let authors;
			if (pub.author.length) {
				authors = pub.author.map(author => `author:: [[${author._}]]`);
			} else {
				authors = [`author:: [[${pub.author._}]]`]
			}
			const content = `---\nkey: ${key}\n---\n\`\`\`bibtex\n${citation}\`\`\`\n${authors.join('\n')}`;

			let path: string;
			if (type === CONFERENCE_TYPE) {
				const venue = pub.booktitle.replaceAll(/[^A-Z]/g, '');
				
				path = `${CONF_PAPER_DIR}/${venue}`;
				try { await this.app.vault.createFolder(path); }
				catch { /* empty */ }

				path = `${path}/${year}`;
				try { await this.app.vault.createFolder(path); }
				catch { /* empty */ }
			} else if (type === JOURNAL_TYPE) {
				path = `${JOURNAL_PAPER_DIR}/${pub.journal}`;
				try { await this.app.vault.createFolder(path); }
				catch { /* empty */ }

				path = `${path}/${year}`;
				try { await this.app.vault.createFolder(path); }
				catch { /* empty */ }
			} else {
				path = `${INFORMAL_PAPER_DIR}/${year}`;
				try { await this.app.vault.createFolder(path); }
				catch { /* empty */ }
			}
			
			let created = await this.createFile(`${path}/${title}.md`, content);
			let altTitle: string;

			if (!created) {
				const file: TFile | null = await this.app.vault.getFileByPath(`${path}/${title}.md`);
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

	private async fetch(dblpUrl: string): void {

		// Fetch and parse XML data
		const response: string = await requestUrl(`${dblpUrl}.xml`).text;
		const xmlData = await parseXml(response);
		const dblpPerson = xmlData.dblpperson;

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

		const confPubs = pubs.filter(x => x.inproceedings).map(x => x.inproceedings);

		const journalPubs = pubs.filter(x => x.article && !x.article.$.publtype).map(x => x.article);

		const informalPubs = pubs.filter(x => x.article && x.article.$.publtype && x.article.$.publtype === 'informal').map(x => x.article);

		await this.createPublicationMdFiles(confPubs, CONFERENCE_TYPE);
		await this.createPublicationMdFiles(journalPubs, JOURNAL_TYPE);
		await this.createPublicationMdFiles(informalPubs, INFORMAL_TYPE);

		// Process coauthors
		let coauthors;
		if (dblpPerson.coauthors.$.n > 1) {
			coauthors = dblpPerson.coauthors.co.map(
				coauthor => {
					if (coauthor.$.n) {
						return { name: coauthor.na[0]._, pid: coauthor.na[0].$.pid };
					} else {
						return { name: coauthor.na._, pid: coauthor.na.$.pid };
					}
				}
			);
		}
		if (dblpPerson.coauthors.$.n == 1) {
			if (dblpPerson.coauthors.co.$.n) {
				coauthors = [ { name: dblpPerson.coauthors.co.na[0]._, pid: dblpPerson.coauthors.co.na[0].$.pid } ];
			} else {
				coauthors = [ { name: dblpPerson.coauthors.co.na._, pid: dblpPerson.coauthors.co.na.$.pid } ];
			}
		}

		const existingPeople = new Set(
			await this.app.vault.getFolderByPath(PEOPLE_DIR).children.map((file: TFile) => file.name)
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

		// console.log(`done fetching data from ${dblpUrl}`);
		new Notice(`done fetching data from ${dblpUrl}`);
	}

	async onunload() { }
}
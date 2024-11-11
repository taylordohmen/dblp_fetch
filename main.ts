import { Editor, MarkdownView, Notice, Plugin, requestUrl, TFile } from 'obsidian';
import * as xml2js from 'xml2js';

const PEOPLE_DIR = 'People';
const CONF_PAPER_DIR = 'Papers/Conference';
const JOURNAL_PAPER_DIR = 'Papers/Journal';
const INFORMAL_PAPER_DIR = 'Papers/Informal';

const DBLP_BASE_PID = 'https://dblp.org/pid';
const DBLP_BASE_PUB = 'https://dblp.dagstuhl.de/rec';

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
	']': '］'
};

const parseXml = async (xmlString: xml2js.convertableToString) => {
	return new Promise((resolve, reject) => {
		xml2js.parseString(xmlString, { ignoreAttrs: false, explicitArray: false },
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

const trimName = (name: string) => name.replaceAll(/[0-9]/g, '').trim();

const sanitize = (fileName: string) => {
	if (typeof fileName !== 'string'){
		fileName = fileName._;
	}
	for (const [key, value] of Object.entries(FORBIDDEN_CHAR_REPLACEMENT)) {
		fileName = fileName.replaceAll(key, value);
	}
	return fileName;
}

const hasProperties = (lines: Array<string>) => lines && lines.length > 0 && lines[0] === '---';

const dblpExists = (lines: Array<string>) => {
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
			editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => {
				const value: string = editor.getValue();
				if (value) {
					const dblpProperty: string | undefined = value
						.split('\n')
						.find(line => line.startsWith('dblp: '));
					if (dblpProperty) {
						const dblpUrl = dblpProperty.substring(6).trim();
						if (!checking) {
							this.fetch(dblpUrl);
						}
						return true;
					}
				}
				return false;
			}
		});

	}

	private async createFile(path, content) {
		try{
			await this.app.vault.create(path, content);
			return true;
		} catch(e) {
			console.log(e);
			console.log(path);
			return false;
		}
	}

	private async createPublicationMdFiles(queued, existingPubs, path) {
		for (const pub of queued) {
			const title = sanitize(pub.title);
			if (!existingPubs.has(title)) {
				const citation = await requestUrl(`${DBLP_BASE_PUB}/${pub.$.key}.bib`).text;
				let authors;
				if (pub.author.length) {
					authors = pub.author.map(author => `author:: [[${trimName(author._)}]]`);
				} else {
					authors = [`author:: [[${trimName(pub.author._)}]]`]
				}
				const content = `\`\`\`bibtex\n${citation}\`\`\`\n${authors.join('\n')}`;
					
				let created = await this.createFile(`${path}/${title}.md`, content);
				if (!created) {
					const altTitle = sanitize(`${title}(${pub.$.key})`);
					console.log(`ALT TITLE: ${altTitle}`);
					created = await this.createFile(`${path}/${altTitle}.md`, content);
				}
				if (!created) {
					console.log(`FAILED TO CREATE: ${path}/${title}.md AND ${path}/${altTitle}.md`);
					console.log('MOVING ON...');
				}
			}
		}
	}

	private async fetch(dblpUrl: string) {

		// Fetch and parse XML data
		const response: string = await requestUrl(`${dblpUrl}.xml`).text;
		const xmlData = await parseXml(response);
		const dblpPerson = xmlData.dblpperson;

		const existingConfPubs: Set<string> = new Set(
			await this.app.vault.getFolderByPath(CONF_PAPER_DIR).children.map((file: TFile) => file.name.slice(0, -3))
		);
		const existingJournalPubs: Set<string> = new Set(
			await this.app.vault.getFolderByPath(JOURNAL_PAPER_DIR).children.map((file: TFile) => file.name.slice(0, -3))
		);
		const existingInformalPubs: Set<string> = new Set(
			await this.app.vault.getFolderByPath(INFORMAL_PAPER_DIR).children.map((file: TFile) => file.name.slice(0, -3))
		);

		const confPubs = dblpPerson.r
			.filter(x => x.inproceedings)
			.map(x => x.inproceedings);
		const journalPubs = dblpPerson.r
			.filter(x => x.article && !x.article.$.publtype)
			.map(x => x.article);
		const informalPubs = dblpPerson.r
			.filter(x => x.article && x.article.$.publtype && x.article.$.publtype === 'informal')
			.map(x => x.article);

		await this.createPublicationMdFiles(confPubs, existingConfPubs, CONF_PAPER_DIR);
		await this.createPublicationMdFiles(journalPubs, existingJournalPubs, JOURNAL_PAPER_DIR);
		await this.createPublicationMdFiles(informalPubs, existingInformalPubs, INFORMAL_PAPER_DIR);


		// Process coauthors
		const coauthors = dblpPerson.coauthors.co
			.map(coauthor => {
				if (coauthor.$.n) {
					return { name: trimName(coauthor.na[0]._), pid: coauthor.na[0].$.pid };
				} else {
					return { name: trimName(coauthor.na._), pid: coauthor.na.$.pid };
				}
			});


		const existingPeople = new Set(
			await this.app.vault.getFolderByPath(PEOPLE_DIR).children.map((file: TFile) => (file.name.slice(0, -3)))
		);

		// Create/update coauthor files
		for (const coauthor of coauthors) {
			const { name, pid } = coauthor;
			const filePath = `${PEOPLE_DIR}/${name}.md`;
			if (existingPeople.has(name)) {
				const file = await this.app.vault.getFileByPath(filePath);
				await this.app.vault.process(file,
					(content: string) => {
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
					}
				);
			} else {
				await this.createFile(filePath, `---\ndblp: ${DBLP_BASE_PID}/${pid}\n---\n`);
			}
		}
		console.log(`done fetching data from ${dblpUrl}`);
		new Notice(`done fetching data from ${dblpUrl}`);
	}

	async onunload() { }
}
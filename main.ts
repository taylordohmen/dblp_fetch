import { Editor, MarkdownView, Plugin, requestUrl, TFile } from 'obsidian';
import * as xml2js from 'xml2js';

const PEOPLE_DIR = 'People';
const PAPER_DIR = 'Papers';

const DBLP_BASE_PID = 'https://dblp.org/pid';
const DBLP_BASE_PUB = 'https://dblp.dagstuhl.de/rec';

const FORBIDDEN_CHAR_REPLACEMENT = {
	'/': '⁄',
	'\\': '＼',
	'[': '［',
	']': '］',
	':': '﹕',
	'^': '＾',
	'|': '┃',
	'#': '＃',
	'?': '﹖'
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

const sanitize = (fileName: string) => Object.entries(FORBIDDEN_CHAR_REPLACEMENT)
	.reduce((acc, [key, value]) => acc.replace(key, value), fileName);

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

	private async fetch(dblpUrl: string) {

		// Fetch and parse XML data
		const response: string = await requestUrl(`${dblpUrl}.xml`).text;
		const xmlData = await parseXml(response);
		const dblpPerson = xmlData.dblpperson;

		const existingPubs: Set<string> = new Set(
			this.app.vault.getFolderByPath(PAPER_DIR).children
				.map((file: TFile) => file.name.slice(0, -3))
		);

		console.log(existingPubs);

		const publications = dblpPerson.r
			.map(x => x.inproceedings || x.article)
			.filter(x => x); //removes undefined elements from the array

		console.log(publications);

		// Create publication files
		for (const pub of publications) {
			let title = sanitize(pub.title);
			if (pub.$.publtype && pub.$.publtype === 'informal') {
				title = `${title}(informal)`;
			}
			if (!existingPubs.has(title)) {
				const citation = await requestUrl(`${DBLP_BASE_PUB}/${pub.$.key}.bib`).text;
				const authors = pub.author
					.map(author => `author:: [[${trimName(author._)}]]`);
				const content = `\`\`\`bibtex\n${citation}\`\`\`\n${authors.join('\n')}`;
				this.app.vault.create(`${PAPER_DIR}/${title}.md`, content);
			}
		}


		// Process coauthors
		const coauthors = dblpPerson.coauthors.co
			.map(coauthor => {
				if (coauthor.$.n) {
					return { name: trimName(coauthor.na[0]._), pid: coauthor.na[0].$.pid };
				} else {
					return { name: trimName(coauthor.na._), pid: coauthor.na.$.pid };
				}
			});

		console.log(coauthors);

		const existingPeople = new Set(this.app.vault.getFolderByPath(PEOPLE_DIR).children
			.map((file: TFile) => (file.name.slice(0, -3)))
		);

		// Create/update coauthor files
		for (const coauthor of coauthors) {
			const { name, pid } = coauthor;
			const filePath = `${PEOPLE_DIR}/${name}.md`;
			if (existingPeople.has(name)) {
				const file = this.app.vault.getFileByPath(filePath);
				this.app.vault.process(file,
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
				this.app.vault.create(filePath, `---\ndblp: ${DBLP_BASE_PID}/${pid}\n---\n`);
			}
		}
	}

	async onunload() { }
}
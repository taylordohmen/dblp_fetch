import { FrontMatterInfo, getFrontMatterInfo, MarkdownView, normalizePath, Notice, Plugin, requestUrl, TFile, TAbstractFile } from 'obsidian';
import * as xml2js from 'xml2js';
import Fuse, { type FuseResult } from 'fuse.js';
import FuzzySet from 'fuzzyset';
import { CONF_PAPER_DIR, DBLP_BASE_URLS, DBLP_PID_ROUTE, DBLP_PUB_ROUTE, DBLP_PROPERTY, EXCEPTION_PREFIXES, FORBIDDEN_CHAR_REPLACEMENT, INFORMAL_PAPER_DIR, JOURNAL_PAPER_DIR, ORG_DIR, PEOPLE_DIR, DBLP_MAIN_URL } from './constants';
import { Article, DblpPerson, DblpPersonData, DblpNote, Coauthor, InProceedings, Person, Publication, isInProceedings, isJournalArticle, isInformalArticle, getCoauthorName, getCoauthorPid } from './dblpTypes';

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
		queued = queued.filter(
			(pub: Publication): boolean => isInProceedings(pub) || isJournalArticle(pub) || isInformalArticle(pub)
		);
		for (const pub of queued) {
			const title: string = sanitize(pub.title);
			const year: string = pub.year;
			const key: string = pub.$.key.trim();

			let citation = '';
			for (const base of DBLP_BASE_URLS) {
				const url = `${base}/${DBLP_PUB_ROUTE}/${pub.$.key}.bib`;
				try {
					citation = await requestUrl(url).text;
				} catch (error) {
					// Probably a timeout exception
					console.log(error);
					console.log(url);
				}
				if (citation) {
					break;
				}
			}
			if (!citation) {
				new Notice(`Unable to fetch data for publication ${title} with key ${pub.$.key}.`);
				continue;
			}


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
						filePath = `${path}/${altTitle}.md`;
						created = await this.createFile(filePath, content);
						if (!created) {
							console.log(`FAILED TO CREATE: ${path}/${title}.md AND ${path}/${altTitle}.md...\nMOVING ON...`);
						}
					}
				}
			}
		}
	}

	private async populatePublicationNotes(dblpPerson: DblpPerson): Promise<void> {
		let pubs: Array<Publication> = [];
		if (dblpPerson.$.n == 1) {
			if ('inproceedings' in dblpPerson.r) {
				pubs = [dblpPerson.r.inproceedings as Publication];
			}
			if ('article' in dblpPerson.r) {
				pubs = [dblpPerson.r.article as Publication];
			}
		} else if (Array.isArray(dblpPerson.r)) {
			pubs = dblpPerson.r.filter(
				(pub: { inproceedings: InProceedings, article: Article }): boolean => 'inproceedings' in pub || 'article' in pub
			).map((pub: { inproceedings: InProceedings, article: Article }): Publication => (
				('inproceedings' in pub && pub.inproceedings) || ('article' in pub && pub.article)
			) as Publication
			);
		}

		await this.createPublicationMdFiles(pubs);
	}

	private async populateAuthorNotes(dblpPerson: DblpPerson): Promise<void> {
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
			const profileUrl = `${DBLP_MAIN_URL}/${DBLP_PID_ROUTE}/${pid}`;
			if (existingPeople.has(name)) {
				const file: TFile | null = this.app.vault.getFileByPath(filePath);
				if (file) {
					await this.app.vault.process(file, (content: string): string => {
						let newContent: Array<string> = content.split('\n');
						if (newContent.length > 0) {
							if (hasProperties(newContent) && !exists(DBLP_PROPERTY, newContent)) {
								newContent.splice(1, 0, `dblp: ${profileUrl}`);
							} else if (!hasProperties(newContent)) {
								newContent = [
									'---',
									`dblp: ${profileUrl}`,
									'---',
									...content
								];
							}
							return newContent.join('\n');
						} else {
							return `---\ndblp: ${profileUrl}\n---\n`;
						}
					});
				}
			} else {
				await this.createFile(filePath, `---\ndblp: ${profileUrl}\n---\n`);
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
						(note: DblpNote): boolean => note.$ !== undefined && note.$.type === 'affiliation' && !note.$.label
					).map(
						(note: DblpNote): string => sliceAtFirstComma(note._)
					)
				);
			} else if (person.note.$ !== undefined && person.note.$.type === 'affiliation' && !person.note.$.label) {
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

		new Notice(`Fetching DBLP profile data for ${personFile.basename}.`)

		const pid = dblpUrl.split(`/${DBLP_PID_ROUTE}/`).at(-1);

		// Fetch xml data for dblp profile
		let response = '';
		for (const base of DBLP_BASE_URLS) {
			const url = `${base}/${DBLP_PID_ROUTE}/${pid}.xml`;
			try {
				response = await requestUrl(url).text;
			} catch (error) {
				// Probably a timeout exception
				console.log(error);
				console.log(url);
			}
			if (response) {
				break;
			}
		}

		if (!response) {
			new Notice(`Unable to fetch data for ${personFile.basename}.`);
			return;
		}

		// Parse XML data
		const xmlData: DblpPersonData = await parseXml(response) as DblpPersonData;
		const dblpPerson: DblpPerson = xmlData.dblpperson;
		const name: string = dblpPerson.$.name;

		new Notice(`Creating publication notes for ${name}...`);
		await this.populatePublicationNotes(dblpPerson);
		new Notice(`Done creating publication notes for ${name}.`);

		new Notice(`Creating co-author notes for ${name}...`);
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

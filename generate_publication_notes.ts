import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import * as axios from 'axios';

// The following two lines configure node so that all array values are printed when printing an array. useful for debugging.
// import * as util from 'node:util';
// util.inspect.defaultOptions.maxArrayLength = null;

// Constants
const PEOPLE_DIR = '/Users/taylordohmen/Documents/plugin-dev/People/';
const PAPER_DIR = '/Users/taylordohmen/Documents/plugin-dev/Papers/';

const DBLP_BASE_PID = 'https://dblp.org/pid/';
const DBLP_BASE_PUB = 'https://dblp.dagstuhl.de/rec/';

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

// Helper functions
const sanitize = (fileName: string) => {
	return Object.entries(FORBIDDEN_CHAR_REPLACEMENT).reduce(
		(acc, [key, value]) => acc.replace(key, value),
		fileName
	);
};

const hasProperties = (lines: Array<string>) => {
	return lines && lines.length > 0 && lines[0] === '---\n';
};

const dblpExists = (lines: Array<string>) => {
	let i = 1;
	while (lines[i] !== '---\n') {
		if (lines[i].startsWith('dblp')) {
			return true;
		}
		i++;
	}
	return false;
};

const trimName = (name: string) => {
	return name.replaceAll('/[0-9]/g', '').trim();
	// return name[name.length - 1].match(/\d/) ? name.slice(0, -5) : name;
};

const parseXml = async (xmlString: xml2js.convertableToString) => {
	return new Promise((resolve, reject) => {
		xml2js.parseString(
			xmlString,
			{ ignoreAttrs: false, explicitArray: false },
			(err, result) => {
				if (err) reject(err);
				else resolve(result);
			}
		);
	});
};

async function main() {
	const [, , dirPath, filename] = process.argv;
	const filepath = path.resolve(dirPath, filename);

	// Read the input file and get DBLP URL
	const fileContent = fs.readFileSync(filepath, 'utf8');
	const lines = fileContent.split('\n');
	const dblpUrl = lines.find(line => line.startsWith('dblp: '))?.slice(6).trim();

	if (!dblpUrl) {
		throw new Error('DBLP URL not found in file');
	}

	// Fetch and parse XML data
	const response = await axios.get(`${dblpUrl}.xml`);
	const xmlData = await parseXml(response.data);
	const dblpPerson = xmlData.dblpperson;

	// Process publications
	const existingPubs = fs.readdirSync(PAPER_DIR)
		.filter(file => file.endsWith('.md'))
		.map(file => file.slice(0, -3));


	const publications = dblpPerson.r.map(
		x => x.inproceedings || x.article
	).filter( //removes undefined elements from the array
		x => x
	);

	// Create publication files
	for (const pub of publications) {

		const title = sanitize(pub.title);
		if (!existingPubs.includes(title)) {
			const citationResponse = await axios.get(`${DBLP_BASE_PUB}${pub.$.key}.bib`);
			const citation = citationResponse.data;
			const authors = pub.author.map(
				author => `author:: [[${trimName(author._)}]]`
			);

			const content = `\`\`\`bibtex\n${citation}\`\`\`\n${authors.join('\n')}`;
			fs.writeFileSync(`${PAPER_DIR}${title}.md`, content);
		}
	}


	// Process coauthors
	const coauthors = dblpPerson.coauthors.co.map(
		coauthor => coauthor.$.n ? ({ name: trimName(coauthor.na[0]._), pid: coauthor.na[0].$.pid }) : ({ name: trimName(coauthor.na._), pid: coauthor.na.$.pid })
	);

	const existingPeople = fs.readdirSync(PEOPLE_DIR)
		.filter(
			file => file.endsWith('.md')
		).map(
			file => file.slice(0, -3)
		);

	// Create/update coauthor files
	for (const coauthor of coauthors) {
		const { name, pid } = coauthor;
		const filePath = `${PEOPLE_DIR}${name}.md`;

		if (existingPeople.includes(name)) {
			let content = fs.readFileSync(filePath, 'utf8').split('\n');
			if (content.length > 0) {
				if (hasProperties(content) && !dblpExists(content)) {
					content.splice(1, 0, `dblp: ${DBLP_BASE_PID}${pid}\n`);
				} else if (!hasProperties(content)) {
					content = [
						'---\n',
						`dblp: ${DBLP_BASE_PID}${pid}\n`,
						'---\n',
						...content
					];
				}
				fs.writeFileSync(filePath, content.join('\n'));
			} else {
				fs.writeFileSync(filePath, `---\ndblp: ${DBLP_BASE_PID}${pid}\n---\n`);
			}
		} else {
			fs.writeFileSync(filePath, `---\ndblp: ${DBLP_BASE_PID}${pid}\n---\n`);
		}
	}
}

main().catch(console.error);



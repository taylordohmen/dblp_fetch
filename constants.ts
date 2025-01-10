export const PEOPLE_DIR = 'People';

export const CONF_PAPER_DIR = 'Papers/Conference';

export const JOURNAL_PAPER_DIR = 'Papers/Journal';

export const INFORMAL_PAPER_DIR = 'Papers/Informal';

export const ORG_DIR = 'Organizations';

export const DBLP_BASE_URLS: Array<string> = [
    'https://dblp.org',
    'https://dblp.uni-trier.de',
    'https://dblp.dagstuhl.de'
];

export const DBLP_MAIN_URL = DBLP_BASE_URLS[0];

export const DBLP_PID_ROUTE = 'pid';
export const DBLP_PUB_ROUTE = 'rec';

export const DBLP_PROPERTY = 'dblp';

export const FORBIDDEN_CHAR_REPLACEMENT = {
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

export const EXCEPTION_PREFIXES: Array<string> = [
    'University of California,'
];
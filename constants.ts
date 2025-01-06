export const PEOPLE_DIR = 'People';

export const CONF_PAPER_DIR = 'Papers/Conference';

export const JOURNAL_PAPER_DIR = 'Papers/Journal';

export const INFORMAL_PAPER_DIR = 'Papers/Informal';

export const ORG_DIR = 'Organizations';

export const DBLP_BASE_PID = 'https://dblp.org/pid';

export const DBLP_BASE_PUB = 'https://dblp.dagstuhl.de/rec';

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
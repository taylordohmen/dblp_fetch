export interface DblpPersonData {
    dblpperson: DblpPerson
}

export interface DblpPerson {
    person: Person,
    coauthors?: CoauthorList,
    r: { inproceedings: InProceedings } | { article: Article } | Array<{ inproceedings: InProceedings } | { article: Article }>,
    $: {
        n: number,
        name: string
    }
}

export interface Person {
    note?: Array<DblpNote> | DblpNote,
    url?: Array<string | { _: string }> | string | { _: string }
}

export interface DblpNote {
    $?: {
        type: string,
        label?: string
    },
    _: string
}

export interface CoauthorList {
    $: { n: number },
    co: Array<Coauthor> | Coauthor
}

export interface Coauthor {
    $: { n?: number },
    na: Array<{ _: string, $: { pid: string } }> | { _: string, $: { pid: string } }
}

export interface InProceedings {
    title: string,
    year: string,
    $: { key: string },
    author: Array<{ _: string }> | { _: string },
    booktitle: string
}

export interface JournalArticle {
    title: string,
    year: string,
    $: { key: string },
    author: Array<{ _: string }> | { _: string },
    journal: string
}

export interface InformalArticle {
    title: string,
    year: string,
    $: {
        key: string,
        publtype: string
    },
    author: Array<{ _: string }> | { _: string },
    journal: string
}

export type Article = JournalArticle | InformalArticle;

export type Publication = InProceedings | JournalArticle | InformalArticle;

export function isInProceedings(x: Publication): x is InProceedings {
    return 'booktitle' in x && '$' in x && !('publtype' in x.$);
}

export function isJournalArticle(x: Publication): x is JournalArticle {
    return 'journal' in x && '$' in x && !('publtype' in x.$);
}

export function isInformalArticle(x: Publication): x is InformalArticle {
    return 'journal' in x && '$' in x && 'publtype' in x.$;
}

export function getCoauthorName(coauthor: Coauthor): string {
    if (Array.isArray(coauthor.na)) {
        return coauthor.na[0]._;
    } else {
        return coauthor.na._;
    }
}

export function getCoauthorPid(coauthor: Coauthor): string {
    if (Array.isArray(coauthor.na)) {
        return coauthor.na[0].$.pid;
    } else {
        return coauthor.na.$.pid;
    }
}

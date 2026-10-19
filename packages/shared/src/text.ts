/** Texto para busca: sem acentos e em minúsculas ("Filé à Parmegiana" → "file a parmegiana"). */
export function searchKey(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** Busca que ignora acentos e maiúsculas. */
export function matchesSearch(text: string, query: string): boolean {
  return searchKey(text).includes(searchKey(query));
}

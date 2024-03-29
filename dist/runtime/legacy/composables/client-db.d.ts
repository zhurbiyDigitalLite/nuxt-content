import { type Storage } from 'unstorage';
import type { NavItem, ParsedContent, QueryBuilder, QueryBuilderParams } from '../../types';
export declare const contentStorage: Storage;
interface ClientDB {
    storage: Storage;
    fetch: (query: QueryBuilder<ParsedContent>) => Promise<ParsedContent | ParsedContent[]>;
    query: (query?: QueryBuilderParams) => QueryBuilder<ParsedContent>;
}
export declare function createDB(storage: Storage): ClientDB;
export declare function useContentDatabase(): Promise<ClientDB>;
export declare function generateNavigation(query?: QueryBuilderParams): Promise<Array<NavItem>>;
export {};

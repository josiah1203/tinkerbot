import { changedService } from "./service";
export function caller(value: string): string { return changedService(value); }

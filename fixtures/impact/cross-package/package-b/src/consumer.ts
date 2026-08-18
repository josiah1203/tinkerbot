import { changedService } from "../../package-a/src/service";
export function consumer(value: string): string { return changedService(value); }

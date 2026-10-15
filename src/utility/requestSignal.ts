import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Cooperative cancellation for every request issued inside an async work scope (for example the
 * lazyload hard timeout). Kept in its own module, free of other imports, so low-level helpers such
 * as `concurrency.ts` and `exploit/utility/rawRequest.ts` can honor it without importing
 * `makeReq.ts`.
 */
const requestSignalContext = new AsyncLocalStorage<AbortSignal>();

/** Supplies cancellation to every request issued in the async work scope. */
export const withRequestSignal = <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> =>
    requestSignalContext.run(signal, work);

/** The cancellation signal of the current async work scope, if any. */
export const getRequestSignal = (): AbortSignal | undefined => requestSignalContext.getStore();

/** True when the current async request scope has been cancelled. */
export const isRequestCancelled = (): boolean => getRequestSignal()?.aborted === true;

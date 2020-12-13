
export type MyErrorType = 'common' | 'not-found' | 'auth' | 'unreachable' | 'method-not-allowed';
export class MyError extends Error {
    constructor(public readonly type: MyErrorType, message?: string) {
        super(message);
    }
}

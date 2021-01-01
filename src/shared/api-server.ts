// backend application server entry (which is generated by api declaration) common
import * as dayjs from 'dayjs';
import { ParameterizedContext } from 'koa';
import type {  UserCredential } from './types/auth';
import { MyError } from './error';

export const dateFormat = 'YYYYMMDD';
export const timeFormat = 'YYYYMMDDHHmmdd';

export type WebContext = ParameterizedContext<{
    user: UserCredential,
}>;

export interface Context {
    user: UserCredential,
}

export function validateNumber(name: string, raw: string): number {
    const result = parseInt(raw);
    if (isNaN(result)) {
        throw new MyError('common', `invalid parameter ${name} value ${raw}`);
    }
    return result;
}

export function validateId(name: string, raw: string): number {
    const result = parseInt(raw);
    if (isNaN(result) || result <= 0) {
        throw new MyError('common', `invalid parameter ${name} value ${raw}`);
    }
    return result;
}

export function validateDate(name: string, raw: string): dayjs.Dayjs {
    const result = dayjs(raw, dateFormat);
    if (!result.isValid()) {
        throw new MyError('common', `invalid parameter ${name} value ${raw}`);
    }
    return result;
}

export function validateTime(name: string, raw: string): dayjs.Dayjs {
    const result = dayjs(raw, timeFormat);
    if (!result.isValid()) {
        throw new MyError('common', `invalid parameter ${name} value ${raw}`);
    }
    return result;
}

export function validateBody<T>(body: any): T {
    if (!body || Object.keys(body).length == 0) {
        throw new MyError('common', 'invalid empty body');
    }
    return body;
}

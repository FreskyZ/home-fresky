// ATTENTION:
// This code was generated by a tool.
// Changes to this file may cause incorrect behavior and will be lost if the code is regenerated.

import type { Dayjs } from 'dayjs';
import { get, post, put, del } from '../../shared/api-client';
import type { Change } from '../api';

export const getChanges = (): Promise<Change[]> => get(`/cost/v1/changes`);
export const createChange = (changeId: number, change: Change): Promise<Change> => post(`/cost/v1/changes/${changeId}`, change);
export const getChange = (changeId: number): Promise<Change> => get(`/cost/v1/changes/${changeId}`);
export const updateChange = (changeId: Dayjs, change: Change): Promise<Change> => put(`/cost/v1/changes/${changeId.format('YYYYMMDD')}`, change);
export const deleteChange = (changeId: Dayjs): Promise<void> => del(`/cost/v1/changes/${changeId.format('YYYYMMDDHHmmdd')}`);

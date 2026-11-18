import { isNonEmptyString } from '@sindresorhus/is';
import JSON5 from 'json5';
import { regEx } from '../../../../util/regex.ts';

export function parseConfigList(val: string): unknown {
  if (val === '') {
    return [];
  }
  try {
    return JSON5.parse(val);
  } catch {
    return val
      .split(',')
      .map((el) => el.trim())
      .filter(isNonEmptyString);
  }
}

export function parseConfigObject(val: string): unknown {
  if (val === '') {
    return {};
  }
  try {
    return JSON5.parse(val);
  } catch {
    throw new Error(`Invalid JSON value: '${val}'`);
  }
}

export function decodeConfigString(val: string): string {
  return val.replace(regEx(/\\n/g), '\n');
}

export const coersions: Record<string, (arg: string) => unknown> = {
  boolean: (val: string): boolean => {
    if (val === 'true' || val === '') {
      return true;
    }
    if (val === 'false') {
      return false;
    }
    throw new Error(
      `Invalid boolean value: expected 'true' or 'false', but got '${val}'`,
    );
  },
  array: parseConfigList,
  object: parseConfigObject,
  string: decodeConfigString,
  integer: parseInt,
};

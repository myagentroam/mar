var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};

// mar-node/test/runs/windows-runtime-probe.6LPn12YM/probe.ts
import { createServer as createServer2 } from 'node:net';

// mar-node/src/remote-desktop/windows-remote-desktop-runtime.ts
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/util.js
var util;
(function (util2) {
  util2.assertEqual = (_) => {};
  function assertIs(_arg) {}
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== 'number');
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function (e) {
      return obj[e];
    });
  };
  util2.objectKeys =
    typeof Object.keys === 'function'
      ? (obj) => Object.keys(obj)
      : (object) => {
          const keys = [];
          for (const key in object) {
            if (Object.prototype.hasOwnProperty.call(object, key)) {
              keys.push(key);
            }
          }
          return keys;
        };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item)) return item;
    }
    return void 0;
  };
  util2.isInteger =
    typeof Number.isInteger === 'function'
      ? (val) => Number.isInteger(val)
      : (val) => typeof val === 'number' && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = ' | ') {
    return array.map((val) => (typeof val === 'string' ? `'${val}'` : val)).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function (objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  'string',
  'nan',
  'number',
  'integer',
  'float',
  'boolean',
  'date',
  'bigint',
  'symbol',
  'function',
  'undefined',
  'null',
  'array',
  'object',
  'unknown',
  'promise',
  'void',
  'never',
  'map',
  'set'
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case 'undefined':
      return ZodParsedType.undefined;
    case 'string':
      return ZodParsedType.string;
    case 'number':
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case 'boolean':
      return ZodParsedType.boolean;
    case 'function':
      return ZodParsedType.function;
    case 'bigint':
      return ZodParsedType.bigint;
    case 'symbol':
      return ZodParsedType.symbol;
    case 'object':
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (
        data.then &&
        typeof data.then === 'function' &&
        data.catch &&
        typeof data.catch === 'function'
      ) {
        return ZodParsedType.promise;
      }
      if (typeof Map !== 'undefined' && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== 'undefined' && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== 'undefined' && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  'invalid_type',
  'invalid_literal',
  'custom',
  'invalid_union',
  'invalid_union_discriminator',
  'invalid_enum_value',
  'unrecognized_keys',
  'invalid_arguments',
  'invalid_return_type',
  'invalid_date',
  'invalid_string',
  'too_small',
  'too_big',
  'invalid_intersection_types',
  'not_multiple_of',
  'not_finite'
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, '$1:');
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = 'ZodError';
    this.issues = issues;
  }
  format(_mapper) {
    const mapper =
      _mapper ||
      function (issue) {
        return issue.message;
      };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === 'invalid_union') {
          issue.unionErrors.map(processError);
        } else if (issue.code === 'invalid_return_type') {
          processError(issue.returnTypeError);
        } else if (issue.code === 'invalid_arguments') {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = 'Required';
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ', ')}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === 'object') {
        if ('includes' in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === 'number') {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ('startsWith' in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ('endsWith' in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== 'regex') {
        message = `Invalid ${issue.validation}`;
      } else {
        message = 'Invalid';
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === 'array')
        message = `Array must contain ${issue.exact ? 'exactly' : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === 'string')
        message = `String must contain ${issue.exact ? 'exactly' : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === 'number')
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === 'bigint')
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === 'date')
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else message = 'Invalid input';
      break;
    case ZodIssueCode.too_big:
      if (issue.type === 'array')
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === 'string')
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === 'number')
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === 'bigint')
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === 'date')
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else message = 'Invalid input';
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = 'Number must be finite';
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...(issueData.path || [])];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = '';
  const maps = errorMaps
    .filter((m) => !!m)
    .slice()
    .reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = 'valid';
  }
  dirty() {
    if (this.value === 'valid') this.value = 'dirty';
  }
  abort() {
    if (this.value !== 'aborted') this.value = 'aborted';
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === 'aborted') return INVALID;
      if (s.status === 'dirty') status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === 'aborted') return INVALID;
      if (value.status === 'aborted') return INVALID;
      if (key.status === 'dirty') status.dirty();
      if (value.status === 'dirty') status.dirty();
      if (key.value !== '__proto__' && (typeof value.value !== 'undefined' || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: 'aborted'
});
var DIRTY = (value) => ({ status: 'dirty', value });
var OK = (value) => ({ status: 'valid', value });
var isAborted = (x) => x.status === 'aborted';
var isDirty = (x) => x.status === 'dirty';
var isValid = (x) => x.status === 'valid';
var isAsync = (x) => typeof Promise !== 'undefined' && x instanceof Promise;

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function (errorUtil2) {
  errorUtil2.errToObj = (message) => (typeof message === 'string' ? { message } : message || {});
  errorUtil2.toString = (message) => (typeof message === 'string' ? message : message?.message);
})(errorUtil || (errorUtil = {}));

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error('Validation failed but no issues detected.');
    }
    return {
      success: false,
      get error() {
        if (this._error) return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params) return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(
      `Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`
    );
  }
  if (errorMap2) return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === 'invalid_enum_value') {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === 'undefined') {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== 'invalid_type') return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return (
      ctx || {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    );
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error('Synchronous parse encountered promise.');
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success) return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  '~validate'(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this['~standard'].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this['~standard'].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result)
          ? {
              value: result.value
            }
          : {
              issues: ctx.common.issues
            };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes('encountered')) {
          this['~standard'].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) =>
      isValid(result)
        ? {
            value: result.value
          }
        : {
            issues: ctx.common.issues
          }
    );
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success) return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult)
      ? maybeAsyncResult
      : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === 'string' || typeof message === 'undefined') {
        return { message };
      } else if (typeof message === 'function') {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () =>
        ctx.addIssue({
          code: ZodIssueCode.custom,
          ...getIssueProperties(val)
        });
      if (typeof Promise !== 'undefined' && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(
          typeof refinementData === 'function' ? refinementData(val, ctx) : refinementData
        );
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: 'refinement', refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this['~standard'] = {
      version: 1,
      vendor: 'zod',
      validate: (data) => this['~validate'](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: 'transform', transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === 'function' ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === 'function' ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex =
  /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex =
  /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex =
  /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex =
  /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex =
  /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? '+' : '?';
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset) opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join('|')})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === 'v4' || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === 'v6' || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt)) return false;
  try {
    const [header] = jwt.split('.');
    if (!header) return false;
    const base64 = header
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(header.length + ((4 - (header.length % 4)) % 4), '=');
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== 'object' || decoded === null) return false;
    if ('typ' in decoded && decoded?.typ !== 'JWT') return false;
    if (!decoded.alg) return false;
    if (alg && decoded.alg !== alg) return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === 'v4' || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === 'v6' || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === 'min') {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: 'string',
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'max') {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: 'string',
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'length') {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: 'string',
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: 'string',
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === 'email') {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'email',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'emoji') {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, 'u');
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'emoji',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'uuid') {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'uuid',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'nanoid') {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'nanoid',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'cuid') {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'cuid',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'cuid2') {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'cuid2',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'ulid') {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'ulid',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'url') {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'url',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'regex') {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'regex',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'trim') {
        input.data = input.data.trim();
      } else if (check.kind === 'includes') {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'toLowerCase') {
        input.data = input.data.toLowerCase();
      } else if (check.kind === 'toUpperCase') {
        input.data = input.data.toUpperCase();
      } else if (check.kind === 'startsWith') {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'endsWith') {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'datetime') {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: 'datetime',
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'date') {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: 'date',
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'time') {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: 'time',
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'duration') {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'duration',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'ip') {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'ip',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'jwt') {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'jwt',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'cidr') {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'cidr',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'base64') {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'base64',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'base64url') {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'base64url',
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: 'email', ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: 'url', ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: 'emoji', ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: 'uuid', ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: 'nanoid', ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: 'cuid', ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: 'cuid2', ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: 'ulid', ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: 'base64', ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: 'base64url',
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: 'jwt', ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: 'ip', ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: 'cidr', ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === 'string') {
      return this._addCheck({
        kind: 'datetime',
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: 'datetime',
      precision: typeof options?.precision === 'undefined' ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: 'date', message });
  }
  time(options) {
    if (typeof options === 'string') {
      return this._addCheck({
        kind: 'time',
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: 'time',
      precision: typeof options?.precision === 'undefined' ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: 'duration', ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: 'regex',
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: 'includes',
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: 'startsWith',
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: 'endsWith',
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: 'min',
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: 'max',
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: 'length',
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: 'trim' }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: 'toLowerCase' }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: 'toUpperCase' }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === 'datetime');
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === 'date');
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === 'time');
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === 'duration');
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === 'email');
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === 'url');
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === 'emoji');
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === 'uuid');
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === 'nanoid');
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === 'cuid');
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === 'cuid2');
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === 'ulid');
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === 'ip');
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === 'cidr');
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === 'base64');
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === 'base64url');
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'min') {
        if (min === null || ch.value > min) min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'max') {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split('.')[1] || '').length;
  const stepDecCount = (step.toString().split('.')[1] || '').length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace('.', ''));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace('.', ''));
  return (valInt % stepInt) / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === 'int') {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: 'integer',
            received: 'float',
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'min') {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: 'number',
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'max') {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: 'number',
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'multipleOf') {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'finite') {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit('min', value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit('min', value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit('max', value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit('max', value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: 'int',
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: 'min',
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: 'max',
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: 'max',
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: 'min',
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: 'multipleOf',
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: 'finite',
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: 'min',
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: 'max',
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'min') {
        if (min === null || ch.value > min) min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'max') {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find(
      (ch) => ch.kind === 'int' || (ch.kind === 'multipleOf' && util.isInteger(ch.value))
    );
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'finite' || ch.kind === 'int' || ch.kind === 'multipleOf') {
        return true;
      } else if (ch.kind === 'min') {
        if (min === null || ch.value > min) min = ch.value;
      } else if (ch.kind === 'max') {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === 'min') {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: 'bigint',
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'max') {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: 'bigint',
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === 'multipleOf') {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit('min', value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit('min', value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit('max', value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit('max', value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: 'min',
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: 'max',
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: 'max',
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: 'min',
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: 'multipleOf',
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'min') {
        if (min === null || ch.value > min) min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'max') {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === 'min') {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: 'date'
          });
          status.dirty();
        }
      } else if (check.kind === 'max') {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: 'date'
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: 'min',
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: 'max',
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'min') {
        if (min === null || ch.value > min) min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'max') {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: 'array',
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: 'array',
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: 'array',
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all(
        [...ctx.data].map((item, i) => {
          return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
        })
      ).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null) return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === 'strip')) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: 'valid', value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === 'passthrough') {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: 'valid', value: key },
            value: { status: 'valid', value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === 'strict') {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === 'strip') {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: 'valid', value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve()
        .then(async () => {
          const syncPairs = [];
          for (const pair of pairs) {
            const key = await pair.key;
            const value = await pair.value;
            syncPairs.push({
              key,
              value,
              alwaysSet: pair.alwaysSet
            });
          }
          return syncPairs;
        })
        .then((syncPairs) => {
          return ParseStatus.mergeObjectSync(status, syncPairs);
        });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: 'strict',
      ...(message !== void 0
        ? {
            errorMap: (issue, ctx) => {
              const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
              if (issue.code === 'unrecognized_keys')
                return {
                  message: errorUtil.errToObj(message).message ?? defaultError
                };
              return {
                message: defaultError
              };
            }
          }
        : {})
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: 'strip'
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: 'passthrough'
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: 'strip',
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: 'strict',
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: 'strip',
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === 'valid') {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === 'dirty') {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(
        options.map(async (option) => {
          const childCtx = {
            ...ctx,
            common: {
              ...ctx.common,
              issues: []
            },
            parent: null
          };
          return {
            result: await option._parseAsync({
              data: ctx.data,
              path: ctx.path,
              parent: childCtx
            }),
            ctx: childCtx
          };
        })
      ).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === 'valid') {
          return result;
        } else if (result.status === 'dirty' && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(
          `A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`
        );
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(
            `Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`
          );
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(
        this._def.left._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      );
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: 'array'
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: 'array'
      });
      status.dirty();
    }
    const items = [...ctx.data]
      .map((item, itemIndex) => {
        const schema = this._def.items[itemIndex] || this._def.rest;
        if (!schema) return null;
        return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
      })
      .filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error('You must pass an array of schemas to z.tuple([ ... ])');
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, 'key'])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, 'value']))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === 'aborted' || value.status === 'aborted') {
            return INVALID;
          }
          if (key.status === 'dirty' || value.status === 'dirty') {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === 'aborted' || value.status === 'aborted') {
          return INVALID;
        }
        if (key.status === 'dirty' || value.status === 'dirty') {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: 'set',
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: 'set',
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === 'aborted') return INVALID;
        if (element.status === 'dirty') status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) =>
      valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i))
    );
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [
          ctx.common.contextualErrorMap,
          ctx.schemaErrorMap,
          getErrorMap(),
          en_default
        ].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [
          ctx.common.contextualErrorMap,
          ctx.schemaErrorMap,
          getErrorMap(),
          en_default
        ].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function (...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type
          .parseAsync(result, params)
          .catch((e) => {
            error.addIssue(makeReturnsIssue(result, e));
            throw error;
          });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function (...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: 'valid', value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== 'string') {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(
      this.options.filter((opt) => !values.includes(opt)),
      {
        ...this._def,
        ...newDef
      }
    );
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified =
      ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(
      promisified.then((data) => {
        return this._def.type.parseAsync(data, {
          path: ctx.path,
          errorMap: ctx.common.contextualErrorMap
        });
      })
    );
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects
      ? this._def.schema.sourceType()
      : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === 'preprocess') {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === 'aborted') return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === 'aborted') return INVALID;
          if (result.status === 'dirty') return DIRTY(result.value);
          if (status.value === 'dirty') return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === 'aborted') return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === 'aborted') return INVALID;
        if (result.status === 'dirty') return DIRTY(result.value);
        if (status.value === 'dirty') return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === 'refinement') {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error(
            'Async refinement encountered during synchronous parse operation. Use .parseAsync instead.'
          );
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === 'aborted') return INVALID;
        if (inner.status === 'dirty') status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema
          ._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx })
          .then((inner) => {
            if (inner.status === 'aborted') return INVALID;
            if (inner.status === 'dirty') status.dirty();
            return executeRefinement(inner.value).then(() => {
              return { status: status.value, value: inner.value };
            });
          });
      }
    }
    if (effect.type === 'transform') {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base)) return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(
            `Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`
          );
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema
          ._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx })
          .then((base) => {
            if (!isValid(base)) return INVALID;
            return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
              status: status.value,
              value: result
            }));
          });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: 'preprocess', transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === 'function' ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: 'valid',
          value:
            result2.status === 'valid'
              ? result2.value
              : this._def.catchValue({
                  get error() {
                    return new ZodError(newCtx.common.issues);
                  },
                  input: newCtx.data
                })
        };
      });
    } else {
      return {
        status: 'valid',
        value:
          result.status === 'valid'
            ? result.value
            : this._def.catchValue({
                get error() {
                  return new ZodError(newCtx.common.issues);
                },
                input: newCtx.data
              })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === 'function' ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: 'valid', value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = /* @__PURE__ */ Symbol('zod_brand');
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === 'aborted') return INVALID;
        if (inResult.status === 'dirty') {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === 'aborted') return INVALID;
      if (inResult.status === 'dirty') {
        status.dirty();
        return {
          status: 'dirty',
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p =
    typeof params === 'function'
      ? params(data)
      : typeof params === 'string'
        ? { message: params }
        : params;
  const p2 = typeof p === 'string' ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: 'custom', ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: 'custom', ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function (ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2['ZodString'] = 'ZodString';
  ZodFirstPartyTypeKind2['ZodNumber'] = 'ZodNumber';
  ZodFirstPartyTypeKind2['ZodNaN'] = 'ZodNaN';
  ZodFirstPartyTypeKind2['ZodBigInt'] = 'ZodBigInt';
  ZodFirstPartyTypeKind2['ZodBoolean'] = 'ZodBoolean';
  ZodFirstPartyTypeKind2['ZodDate'] = 'ZodDate';
  ZodFirstPartyTypeKind2['ZodSymbol'] = 'ZodSymbol';
  ZodFirstPartyTypeKind2['ZodUndefined'] = 'ZodUndefined';
  ZodFirstPartyTypeKind2['ZodNull'] = 'ZodNull';
  ZodFirstPartyTypeKind2['ZodAny'] = 'ZodAny';
  ZodFirstPartyTypeKind2['ZodUnknown'] = 'ZodUnknown';
  ZodFirstPartyTypeKind2['ZodNever'] = 'ZodNever';
  ZodFirstPartyTypeKind2['ZodVoid'] = 'ZodVoid';
  ZodFirstPartyTypeKind2['ZodArray'] = 'ZodArray';
  ZodFirstPartyTypeKind2['ZodObject'] = 'ZodObject';
  ZodFirstPartyTypeKind2['ZodUnion'] = 'ZodUnion';
  ZodFirstPartyTypeKind2['ZodDiscriminatedUnion'] = 'ZodDiscriminatedUnion';
  ZodFirstPartyTypeKind2['ZodIntersection'] = 'ZodIntersection';
  ZodFirstPartyTypeKind2['ZodTuple'] = 'ZodTuple';
  ZodFirstPartyTypeKind2['ZodRecord'] = 'ZodRecord';
  ZodFirstPartyTypeKind2['ZodMap'] = 'ZodMap';
  ZodFirstPartyTypeKind2['ZodSet'] = 'ZodSet';
  ZodFirstPartyTypeKind2['ZodFunction'] = 'ZodFunction';
  ZodFirstPartyTypeKind2['ZodLazy'] = 'ZodLazy';
  ZodFirstPartyTypeKind2['ZodLiteral'] = 'ZodLiteral';
  ZodFirstPartyTypeKind2['ZodEnum'] = 'ZodEnum';
  ZodFirstPartyTypeKind2['ZodEffects'] = 'ZodEffects';
  ZodFirstPartyTypeKind2['ZodNativeEnum'] = 'ZodNativeEnum';
  ZodFirstPartyTypeKind2['ZodOptional'] = 'ZodOptional';
  ZodFirstPartyTypeKind2['ZodNullable'] = 'ZodNullable';
  ZodFirstPartyTypeKind2['ZodDefault'] = 'ZodDefault';
  ZodFirstPartyTypeKind2['ZodCatch'] = 'ZodCatch';
  ZodFirstPartyTypeKind2['ZodPromise'] = 'ZodPromise';
  ZodFirstPartyTypeKind2['ZodBranded'] = 'ZodBranded';
  ZodFirstPartyTypeKind2['ZodPipeline'] = 'ZodPipeline';
  ZodFirstPartyTypeKind2['ZodReadonly'] = 'ZodReadonly';
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (
  cls,
  params = {
    message: `Input not instance of ${cls.name}`
  }
) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: (arg) => ZodString.create({ ...arg, coerce: true }),
  number: (arg) => ZodNumber.create({ ...arg, coerce: true }),
  boolean: (arg) =>
    ZodBoolean.create({
      ...arg,
      coerce: true
    }),
  bigint: (arg) => ZodBigInt.create({ ...arg, coerce: true }),
  date: (arg) => ZodDate.create({ ...arg, coerce: true })
};
var NEVER = INVALID;

// packages/protocol/src/remote-desktop.ts
var id = external_exports
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
var nodeId = external_exports.string().min(1).max(512);
var revision = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var timestamp = external_exports.number().int().positive().max(Number.MAX_SAFE_INTEGER);
var code = external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
var grant = external_exports.string().min(32).max(4096);
var fingerprint = external_exports.string().regex(/^sha-256(?: [A-F0-9]{2}(?::[A-F0-9]{2}){31})$/u);
var remoteDesktopModeSchema = external_exports.enum(['VIEW', 'CONTROL']);
var nativeCoordinate = external_exports.number().finite().min(-2147483648).max(2147483647);
var dimension = external_exports.number().int().positive().max(65535);
var nativeRectangle = external_exports
  .object({
    x: nativeCoordinate,
    y: nativeCoordinate,
    width: external_exports.number().finite().positive().max(65535),
    height: external_exports.number().finite().positive().max(65535)
  })
  .strict();
var framebufferRectangle = external_exports
  .object({
    x: external_exports.number().int().nonnegative().max(65535),
    y: external_exports.number().int().nonnegative().max(65535),
    width: dimension,
    height: dimension
  })
  .strict();
var coefficient = external_exports.number().finite().min(-1e6).max(1e6);
var remoteDesktopDescriptionSchema = external_exports
  .object({
    desktopGeneration: id,
    topologyRevision: revision,
    framebuffer: external_exports.object({ width: dimension, height: dimension }).strict(),
    displays: external_exports
      .array(
        external_exports
          .object({
            displayId: id,
            name: external_exports.string().min(1).max(256),
            primary: external_exports.boolean(),
            nativeBounds: nativeRectangle,
            framebufferBounds: framebufferRectangle,
            nativeToFramebuffer: external_exports.tuple([
              coefficient,
              coefficient,
              coefficient,
              coefficient,
              coefficient,
              coefficient
            ])
          })
          .strict()
      )
      .min(1)
      .max(64)
  })
  .strict()
  .superRefine((description, context) => {
    const seen = /* @__PURE__ */ new Set();
    let primaryCount = 0;
    description.displays.forEach((display, index) => {
      const bounds = display.framebufferBounds;
      if (seen.has(display.displayId))
        context.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ['displays', index, 'displayId'],
          message: 'Duplicate display ID'
        });
      seen.add(display.displayId);
      if (display.primary) primaryCount++;
      if (
        bounds.x < 0 ||
        bounds.y < 0 ||
        bounds.x + bounds.width > description.framebuffer.width ||
        bounds.y + bounds.height > description.framebuffer.height
      )
        context.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ['displays', index, 'framebufferBounds'],
          message: 'Display is outside the framebuffer'
        });
      const [a, b, c, d, tx, ty] = display.nativeToFramebuffer;
      const native = display.nativeBounds;
      const corners = [
        [native.x, native.y],
        [native.x + native.width, native.y],
        [native.x, native.y + native.height],
        [native.x + native.width, native.y + native.height]
      ].map(([x, y]) => [a * x + c * y + tx, b * x + d * y + ty]);
      const xs = corners.map((corner) => corner[0]);
      const ys = corners.map((corner) => corner[1]);
      if (
        Math.abs(a * d - b * c) < 1e-12 ||
        Math.abs(Math.min(...xs) - bounds.x) > 1 ||
        Math.abs(Math.min(...ys) - bounds.y) > 1 ||
        Math.abs(Math.max(...xs) - bounds.x - bounds.width) > 1 ||
        Math.abs(Math.max(...ys) - bounds.y - bounds.height) > 1
      )
        context.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ['displays', index, 'nativeToFramebuffer'],
          message: 'Display mapping does not match its bounds'
        });
    });
    if (primaryCount !== 1)
      context.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: ['displays'],
        message: 'Exactly one primary display is required'
      });
  });
var remoteDesktopCapabilitySchema = external_exports.discriminatedUnion('available', [
  external_exports
    .object({
      apiVersion: external_exports.literal(1),
      available: external_exports.literal(false),
      nodeGeneration: id,
      reasonCode: code
    })
    .strict(),
  external_exports
    .object({
      apiVersion: external_exports.literal(1),
      available: external_exports.literal(true),
      nodeGeneration: id,
      backend: external_exports.enum(['TIGERVNC_X0', 'ULTRAVNC', 'MACVNC']),
      supportsView: external_exports.literal(true),
      supportsControl: external_exports.boolean(),
      supportsMultiDisplay: external_exports.boolean(),
      supportsUnicodePaste: external_exports.boolean(),
      transports: external_exports
        .array(external_exports.enum(['DIRECT', 'RELAY']))
        .min(1)
        .max(2)
        .refine((items) => new Set(items).size === items.length)
    })
    .strict()
]);
var remoteDesktopDirectBrowserMessageSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.prepare'),
      requestId: id,
      nodeId,
      nodeGeneration: id,
      transportSessionId: id,
      desktopGeneration: id,
      topologyRevision: revision,
      mode: remoteDesktopModeSchema
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.direct.heartbeat'), attachmentId: id })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.direct.cancel'), attachmentId: id })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.ready'), attachmentId: id })
    .strict()
]);
var remoteDesktopDirectServerMessageSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.prepared'),
      requestId: id,
      attachmentId: id,
      grant,
      openExpiresAt: timestamp,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.heartbeat'),
      attachmentId: id,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.direct.closed'), attachmentId: id, code })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.direct.settled'), attachmentId: id, code })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.error'),
      requestId: id.optional(),
      attachmentId: id.optional(),
      settled: external_exports.literal(true).optional(),
      code,
      message: external_exports.string().min(1).max(1e3)
    })
    .strict()
]);
var remoteDesktopDirectNodeCommandSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.prepare'),
      attachmentId: id,
      transportSessionId: id,
      workbenchConnectionId: id,
      nodeGeneration: id,
      desktopGeneration: id,
      topologyRevision: revision,
      mode: remoteDesktopModeSchema,
      grant,
      browserFingerprint: fingerprint,
      nodeFingerprint: fingerprint,
      openExpiresAt: timestamp,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.heartbeat'),
      attachmentId: id,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.direct.cancel'), attachmentId: id, code })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.ready'), attachmentId: id })
    .strict()
]);
var remoteDesktopDirectNodeEventSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.ready'),
      attachmentId: id,
      nodeGeneration: id,
      phase: external_exports.enum(['PREPARED', 'OPEN', 'ATTACHED', 'ACTIVE'])
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.closed'),
      attachmentId: id,
      nodeGeneration: id,
      code
    })
    .strict()
]);
var remoteDesktopRelayBrowserMessageSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.prepare'),
      requestId: id,
      nodeId,
      nodeGeneration: id,
      desktopGeneration: id,
      topologyRevision: revision,
      mode: remoteDesktopModeSchema
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.relay.heartbeat'), attachmentId: id })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.relay.cancel'), attachmentId: id })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.ready'), attachmentId: id })
    .strict()
]);
var remoteDesktopRelayServerMessageSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.prepared'),
      requestId: id,
      attachmentId: id,
      grant,
      ticket: grant,
      openExpiresAt: timestamp,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.heartbeat'),
      attachmentId: id,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.relay.closed'), attachmentId: id, code })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.relay.settled'), attachmentId: id, code })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.error'),
      requestId: id.optional(),
      attachmentId: id.optional(),
      settled: external_exports.literal(true).optional(),
      code,
      message: external_exports.string().min(1).max(1e3)
    })
    .strict()
]);
var remoteDesktopRelayNodeCommandSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.prepare'),
      attachmentId: id,
      workbenchConnectionId: id,
      nodeGeneration: id,
      desktopGeneration: id,
      topologyRevision: revision,
      mode: remoteDesktopModeSchema,
      grant,
      ticket: grant,
      openExpiresAt: timestamp,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.heartbeat'),
      attachmentId: id,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.relay.cancel'), attachmentId: id, code })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.ready'), attachmentId: id })
    .strict()
]);
var remoteDesktopRelayNodeEventSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.ready'),
      attachmentId: id,
      nodeGeneration: id,
      phase: external_exports.enum(['PREPARED', 'OPEN', 'ATTACHED', 'ACTIVE'])
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.closed'),
      attachmentId: id,
      nodeGeneration: id,
      code
    })
    .strict()
]);
var remoteDesktopRelayBrowserAttachSchema = external_exports
  .object({
    type: external_exports.literal('desktop.relay.browser'),
    attachmentId: id,
    workbenchConnectionId: id,
    ticket: grant
  })
  .strict();
var remoteDesktopRelayNodeAttachSchema = external_exports
  .object({
    type: external_exports.literal('desktop.relay.node'),
    nodeId,
    nodeGeneration: id,
    attachmentId: id,
    ticket: grant,
    credential: external_exports.string().min(1).max(4096)
  })
  .strict();
var remoteDesktopDirectOpenFrameSchema = external_exports
  .object({
    type: external_exports.literal('OPEN'),
    attachmentId: id,
    grant
  })
  .strict();
var remoteDesktopAttachedFrameSchema = external_exports
  .object({
    type: external_exports.literal('ATTACHED'),
    attachmentId: id
  })
  .strict();

// mar-node/src/remote-desktop/desktop-error.ts
var messages = {
  DESKTOP_UNAVAILABLE: 'Remote desktop is unavailable on this Node.',
  DESKTOP_RFB_INVALID: 'The remote desktop protocol message is invalid.',
  DESKTOP_RFB_CLOSED: 'The remote desktop input stream is closed.',
  DESKTOP_INPUT_DENIED: 'This remote desktop attachment cannot send input.',
  DESKTOP_CONTROL_LOST: 'Remote desktop control is no longer held.',
  DESKTOP_BACKPRESSURE: 'The remote desktop input buffer exceeded its limit.',
  DESKTOP_TRANSPORT_ERROR: 'The remote desktop transport failed.',
  DESKTOP_BACKEND_AUTH_UNAVAILABLE: 'The desktop backend does not offer required authentication.',
  DESKTOP_BACKEND_AUTH_FAILED: 'The desktop backend rejected authentication.',
  DESKTOP_BACKEND_CONFIG_INVALID: 'The desktop backend configuration is invalid.',
  DESKTOP_BACKEND_START_FAILED: 'The desktop backend could not start.',
  DESKTOP_BACKEND_SOCKET_INVALID: 'The desktop backend socket is not private.',
  DESKTOP_BACKEND_CLOSED: 'The desktop backend is closed.',
  DESKTOP_BACKEND_STOP_FAILED: 'The desktop backend could not be stopped.',
  DESKTOP_BACKEND_STOP_TIMEOUT: 'The desktop backend did not stop in time.',
  DESKTOP_SETUP_TIMEOUT: 'The remote desktop setup timed out.',
  DESKTOP_SETUP_CANCELLED: 'The remote desktop setup was cancelled.',
  DESKTOP_TOPOLOGY_UNAVAILABLE: 'The native desktop topology is unavailable.',
  DESKTOP_NATIVE_CHANNEL_CLOSED: 'The native desktop control channel is closed.',
  DESKTOP_NATIVE_ID_UNAVAILABLE: 'A unique native desktop attachment ID could not be created.',
  DESKTOP_NATIVE_WAIT_IN_PROGRESS: 'Native desktop cleanup is already being awaited.',
  DESKTOP_NATIVE_CLEANUP_TIMEOUT: 'Native desktop input cleanup timed out.',
  DESKTOP_NATIVE_CLEANUP_FAILED: 'The native desktop backend could not confirm input cleanup.',
  DESKTOP_NATIVE_ATTACHMENTS_ACTIVE: 'Desktop attachments are still active.'
};
var RemoteDesktopError = class extends Error {
  constructor(code2) {
    super(messages[code2]);
    this.code = code2;
    this.name = 'RemoteDesktopError';
  }
  code;
};

// mar-node/src/remote-desktop/pooled-desktop-attachment.ts
var PooledDesktopAttachment = class {
  constructor(pool, frontend, create) {
    this.pool = pool;
    this.frontend = frontend;
    this.create = create;
  }
  pool;
  frontend;
  create;
  #cancel = new AbortController();
  #reference;
  #attachment;
  #opening;
  #closing;
  #closed = false;
  #started = false;
  open(signal) {
    if (this.#started || this.#closed)
      return Promise.reject(new RemoteDesktopError('DESKTOP_RFB_CLOSED'));
    this.#started = true;
    const deadline = AbortSignal.any([signal, this.#cancel.signal]);
    this.#opening = (async () => {
      this.#reference = await this.pool.acquire(deadline);
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      this.#attachment = this.create(this.#reference.backend);
      await this.#attachment.open(deadline);
    })();
    return this.#opening;
  }
  close(signal) {
    if (this.#closed) return Promise.resolve();
    if (this.#closing) return this.#closing;
    this.#cancel.abort();
    const closing = this.#attachment?.close(signal).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    if (!this.#attachment) this.frontend.destroy();
    this.#closing = (async () => {
      await this.#opening?.catch(() => {});
      if (closing) {
        const result = await closing;
        if (!result.ok) throw result.error;
      } else if (this.#attachment) await this.#attachment.close(signal);
      if (this.#reference) await this.#reference.release();
      this.#reference = void 0;
      this.#attachment = void 0;
      this.#closed = true;
    })().finally(() => {
      this.#closing = void 0;
    });
    return this.#closing;
  }
};

// mar-node/src/remote-desktop/rfb-handshake-io.ts
var RfbHandshakeIo = class {
  constructor(stream, signal) {
    this.stream = stream;
    this.signal = signal;
    stream.pause();
    stream.on('error', this.#failed);
    stream.on('close', this.#closed);
    stream.on('end', this.#closed);
    signal.addEventListener('abort', this.#aborted);
    if (signal.aborted) this.#aborted();
  }
  stream;
  signal;
  #error;
  #pending;
  async read(size) {
    if (size === 0) return Buffer.alloc(0);
    while (true) {
      this.#check();
      const value = this.stream.read(size);
      if (value !== null) {
        if (!Buffer.isBuffer(value) || value.length !== size)
          throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
        return value;
      }
      await new Promise((resolve, reject) => {
        const readable = () => finish();
        const finish = (error) => {
          this.stream.off('readable', readable);
          this.#pending = void 0;
          if (error) reject(error);
          else resolve();
        };
        this.#pending = finish;
        this.stream.once('readable', readable);
      });
    }
  }
  async write(value) {
    this.#check();
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        if (this.#pending !== finish) return;
        this.#pending = void 0;
        if (error) reject(error);
        else resolve();
      };
      this.#pending = finish;
      try {
        this.stream.write(value, (error) =>
          finish(error ? new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR') : void 0)
        );
      } catch {
        finish(new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR'));
      }
    });
  }
  dispose() {
    if (this.stream.destroyed && !this.stream.closed) {
      this.stream.once('close', () => this.stream.off('error', this.#failed));
    } else this.stream.off('error', this.#failed);
    this.stream.off('close', this.#closed);
    this.stream.off('end', this.#closed);
    this.signal.removeEventListener('abort', this.#aborted);
  }
  #check() {
    if (this.#error) throw this.#error;
    if (this.stream.destroyed || this.stream.readableEnded)
      throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
  }
  #fail(error) {
    if (this.#error) return;
    this.#error = error;
    this.#pending?.(error);
  }
  #failed = () => this.#fail(new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR'));
  #closed = () => this.#fail(new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR'));
  #aborted = () => this.#fail(new RemoteDesktopError('DESKTOP_SETUP_CANCELLED'));
};

// mar-node/src/remote-desktop/rfb-frontend-handshake.ts
async function handshakeRfbFrontend(stream, serverInit, signal) {
  const io = new RfbHandshakeIo(stream, signal);
  try {
    if (
      serverInit.length < 24 ||
      serverInit.length > 24 + 4096 ||
      serverInit.readUInt32BE(20) !== serverInit.length - 24
    )
      throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    const banner = Buffer.from('RFB 003.008\n');
    await io.write(banner);
    if (!(await io.read(12)).equals(banner)) throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    await io.write(Buffer.from([1, 1]));
    if ((await io.read(1))[0] !== 1) throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    await io.write(Buffer.alloc(4));
    if ((await io.read(1))[0] !== 1) throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    await io.write(serverInit);
  } catch (error) {
    stream.destroy();
    if (error instanceof RemoteDesktopError) throw error;
    throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
  } finally {
    io.dispose();
  }
}

// mar-node/src/remote-desktop/rfb-client-gate.ts
var RfbClientGate = class _RfbClientGate {
  constructor(target, mode, isControlOwner, onFailure) {
    this.target = target;
    this.mode = mode;
    this.isControlOwner = isControlOwner;
    this.onFailure = onFailure;
    target.on('drain', this.#drain);
    target.on('error', this.#streamError);
    target.on('close', this.#streamError);
  }
  target;
  mode;
  isControlOwner;
  onFailure;
  static maxClipboardBytes = 1024 * 1024;
  static maxEncodings = 256;
  static maxPressedKeys = 256;
  static maxQueuedFrames = 1024;
  static maxFrameBytes = _RfbClientGate.maxClipboardBytes + 8;
  #buffer = Buffer.allocUnsafe(_RfbClientGate.maxFrameBytes);
  #queue = [];
  #keys = /* @__PURE__ */ new Set();
  #begin = 0;
  #end = 0;
  #queuedBytes = 0;
  #buttons = 0;
  #pointerX = 0;
  #pointerY = 0;
  #waitingDrain = false;
  #inFlight = 0;
  #inFlightBytes = 0;
  #extendedClipboard = false;
  #state = 'active';
  #fencePromise;
  #fenceResolve;
  #fenceReject;
  receive(data) {
    if (this.#state !== 'active') return;
    let offset = 0;
    while (offset < data.byteLength && this.#state === 'active') {
      if (this.#end === this.#buffer.length && this.#begin > 0) {
        this.#buffer.copyWithin(0, this.#begin, this.#end);
        this.#end -= this.#begin;
        this.#begin = 0;
      }
      const count = Math.min(data.byteLength - offset, this.#buffer.length - this.#end);
      if (count === 0) {
        this.#fail('DESKTOP_RFB_INVALID');
        return;
      }
      this.#buffer.set(data.subarray(offset, offset + count), this.#end);
      this.#end += count;
      offset += count;
      this.#parse();
    }
  }
  /** Fencing discards unwritten messages; write completion is not an OS input ACK. */
  fence() {
    if (this.#fencePromise !== void 0) return this.#fencePromise;
    if (this.#state === 'failed')
      return Promise.reject(new RemoteDesktopError('DESKTOP_RFB_CLOSED'));
    this.#state = 'fenced';
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#begin = this.#end = 0;
    this.#fencePromise =
      this.#waitingDrain || this.#inFlight > 0
        ? new Promise((resolve, reject) => {
            this.#fenceResolve = resolve;
            this.#fenceReject = reject;
          })
        : Promise.resolve(this.#snapshot());
    return this.#fencePromise;
  }
  /** Available after failure for native cleanup; it does not confirm delivery or release. */
  submittedInputSnapshot() {
    return this.#snapshot();
  }
  dispose() {
    this.#state = 'failed';
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.target.removeListener('drain', this.#drain);
    this.target.removeListener('error', this.#streamError);
    this.target.removeListener('close', this.#streamError);
    this.#fenceReject?.(new RemoteDesktopError('DESKTOP_RFB_CLOSED'));
    this.#fenceResolve = this.#fenceReject = void 0;
  }
  #parse() {
    while (this.#begin < this.#end && this.#state === 'active') {
      const length = this.#frameLength();
      if (length === void 0 || this.#state !== 'active') return;
      if (this.#end - this.#begin < length) return;
      let bytes = Buffer.from(this.#buffer.subarray(this.#begin, this.#begin + length));
      this.#begin += length;
      if (this.#begin === this.#end) this.#begin = this.#end = 0;
      const input = bytes[0] === 4 || bytes[0] === 5 || bytes[0] === 6;
      if (input && this.mode === 'VIEW') {
        this.#fail('DESKTOP_INPUT_DENIED');
        return;
      }
      if (bytes[0] === 4 && bytes[1] > 1) {
        this.#fail('DESKTOP_RFB_INVALID');
        return;
      }
      if (bytes[0] === 2) {
        bytes = this.#filterEncodings(bytes);
        this.#extendedClipboard = this.mode === 'CONTROL' && this.#hasExtendedClipboard(bytes);
      }
      if (bytes[0] === 6 && !this.#validClipboard(bytes)) {
        this.#fail('DESKTOP_RFB_INVALID');
        return;
      }
      if (
        this.#queue.length >= _RfbClientGate.maxQueuedFrames ||
        this.#queuedBytes + bytes.length > _RfbClientGate.maxFrameBytes
      ) {
        this.#fail('DESKTOP_BACKPRESSURE');
        return;
      }
      this.#queue.push({ bytes, input });
      this.#queuedBytes += bytes.length;
      this.#pump();
    }
  }
  #frameLength() {
    const available = this.#end - this.#begin;
    const type = this.#buffer[this.#begin];
    switch (type) {
      case 0:
        return 20;
      case 2: {
        if (available < 4) return void 0;
        const count = this.#buffer.readUInt16BE(this.#begin + 2);
        if (count > _RfbClientGate.maxEncodings) {
          this.#fail('DESKTOP_RFB_INVALID');
          return void 0;
        }
        return 4 + count * 4;
      }
      case 3:
        return 10;
      case 4:
        return 8;
      case 5:
        return 6;
      case 6: {
        if (available < 8) return void 0;
        const declared = this.#buffer.readInt32BE(this.#begin + 4);
        const length = Math.abs(declared);
        if (length > _RfbClientGate.maxClipboardBytes) {
          this.#fail('DESKTOP_RFB_INVALID');
          return void 0;
        }
        return 8 + length;
      }
      default:
        this.#fail('DESKTOP_RFB_INVALID');
        return void 0;
    }
  }
  #filterEncodings(frame) {
    const allowed = [];
    for (let offset = 4; offset < frame.length; offset += 4) {
      const encoding = frame.readInt32BE(offset);
      if (
        [0, 1, 2, 5, 7, 16, 21, -223, -224, -239, -308].includes(encoding) ||
        (encoding >= -32 && encoding <= -23) ||
        (encoding >= -256 && encoding <= -247) ||
        (this.mode === 'CONTROL' && encoding === -1063131698)
      )
        allowed.push(encoding);
    }
    const filtered = Buffer.allocUnsafe(4 + allowed.length * 4);
    filtered[0] = 2;
    filtered[1] = 0;
    filtered.writeUInt16BE(allowed.length, 2);
    allowed.forEach((encoding, index) => filtered.writeInt32BE(encoding, 4 + index * 4));
    return filtered;
  }
  #hasExtendedClipboard(frame) {
    for (let offset = 4; offset < frame.length; offset += 4) {
      if (frame.readInt32BE(offset) === -1063131698) return true;
    }
    return false;
  }
  #validClipboard(frame) {
    if (frame.readInt32BE(4) >= 0) return true;
    if (!this.#extendedClipboard || frame.length < 12) return false;
    const flags = frame.readUInt32BE(8);
    const formats = flags & 65535;
    const actions = flags & 4278190080;
    if ((flags & 16711680) !== 0 || (formats & ~1) !== 0) return false;
    if ((actions & 16777216) !== 0) {
      return (actions & ~452984832) === 0 && frame.length === 12 + (formats === 1 ? 4 : 0);
    }
    if (actions === 134217728) return frame.length === 12;
    return actions === 268435456 && formats === 1 && frame.length > 12;
  }
  #pump() {
    while (this.#state === 'active' && !this.#waitingDrain && this.#queue.length > 0) {
      const next = this.#queue[0];
      if (
        this.#inFlight >= _RfbClientGate.maxQueuedFrames ||
        this.#inFlightBytes + next.bytes.length > _RfbClientGate.maxFrameBytes
      )
        return;
      const frame = this.#queue.shift();
      this.#queuedBytes -= frame.bytes.length;
      if (frame.input) {
        let ownsControl = false;
        try {
          ownsControl = this.isControlOwner();
        } catch {}
        if (!ownsControl) {
          this.#fail('DESKTOP_CONTROL_LOST');
          return;
        }
      }
      if (
        frame.bytes[0] === 4 &&
        frame.bytes[1] === 1 &&
        !this.#keys.has(frame.bytes.readUInt32BE(4)) &&
        this.#keys.size >= _RfbClientGate.maxPressedKeys
      ) {
        this.#fail('DESKTOP_RFB_INVALID');
        return;
      }
      try {
        this.#inFlight++;
        this.#inFlightBytes += frame.bytes.length;
        const accepted = this.target.write(frame.bytes, (error) => {
          this.#inFlight--;
          this.#inFlightBytes -= frame.bytes.length;
          if (error) this.#fail('DESKTOP_TRANSPORT_ERROR');
          else if (this.#state === 'fenced') this.#finishFence();
          else this.#pump();
        });
        this.#recordInput(frame.bytes);
        this.#waitingDrain = !accepted;
      } catch {
        this.#inFlight--;
        this.#inFlightBytes -= frame.bytes.length;
        this.#fail('DESKTOP_TRANSPORT_ERROR');
      }
    }
  }
  #recordInput(frame) {
    if (frame[0] === 4) {
      const key = frame.readUInt32BE(4);
      if (frame[1] !== 0) this.#keys.add(key);
      else this.#keys.delete(key);
    } else if (frame[0] === 5) {
      this.#buttons = frame[1];
      this.#pointerX = frame.readUInt16BE(2);
      this.#pointerY = frame.readUInt16BE(4);
    }
  }
  #snapshot() {
    return { keys: [...this.#keys], buttons: this.#buttons, x: this.#pointerX, y: this.#pointerY };
  }
  #drain = () => {
    this.#waitingDrain = false;
    if (this.#state === 'fenced') this.#finishFence();
    else this.#pump();
  };
  #finishFence() {
    if (this.#state === 'fenced' && !this.#waitingDrain && this.#inFlight === 0) {
      this.#fenceResolve?.(this.#snapshot());
      this.#fenceResolve = this.#fenceReject = void 0;
    }
  }
  #streamError = () => this.#fail('DESKTOP_TRANSPORT_ERROR');
  #fail(code2) {
    if (this.#state === 'failed') return;
    this.#state = 'failed';
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#fenceReject?.(new RemoteDesktopError(code2));
    this.#fenceResolve = this.#fenceReject = void 0;
    this.onFailure(code2);
  }
};

// mar-node/src/remote-desktop/rfb-input-release.ts
async function submitRfbInputRelease(gate, target, signal) {
  const snapshot = await abortable(gate.fence(), signal);
  const bytes = releaseFrames(snapshot);
  if (!bytes.length) return;
  if (signal.aborted || target.destroyed || !target.writable)
    throw new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_FAILED');
  await new Promise((resolve, reject) => {
    const onError = () => finish(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_FAILED'));
    const onClose = () => finish(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_FAILED'));
    const onAbort = () => finish(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_TIMEOUT'));
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      target.off('error', onError);
      target.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    target.once('error', onError);
    target.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      target.write(bytes, (error) =>
        finish(error ? new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_FAILED') : void 0)
      );
    } catch {
      finish(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_FAILED'));
    }
  });
}
function releaseFrames(snapshot) {
  const modifier = (key) => key === 65406 || (key >= 65505 && key <= 65518);
  const keys = [
    ...snapshot.keys.filter((key) => !modifier(key)),
    ...snapshot.keys.filter(modifier)
  ];
  const frames = keys.map((key) => {
    const frame = Buffer.alloc(8);
    frame[0] = 4;
    frame.writeUInt32BE(key, 4);
    return frame;
  });
  if (snapshot.buttons & 7) {
    const frame = Buffer.alloc(6);
    frame[0] = 5;
    frame.writeUInt16BE(snapshot.x, 2);
    frame.writeUInt16BE(snapshot.y, 4);
    frames.push(frame);
  }
  return Buffer.concat(frames);
}
async function abortable(operation, signal) {
  if (signal.aborted) {
    void operation.catch(() => {});
    throw new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_TIMEOUT');
  }
  return await new Promise((resolve, reject) => {
    const abort = () =>
      finish(() => reject(new RemoteDesktopError('DESKTOP_NATIVE_CLEANUP_TIMEOUT')));
    const finish = (done) => {
      signal.removeEventListener('abort', abort);
      done();
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

// mar-node/src/remote-desktop/standard-rfb-attachment.ts
var StandardRfbAttachment = class {
  constructor(socket, gate) {
    this.socket = socket;
    this.gate = gate;
    socket.on('error', this.#ignoreLateError);
    socket.once('close', () => socket.off('error', this.#ignoreLateError));
  }
  socket;
  gate;
  #closing;
  #closed = false;
  #ignoreLateError = () => {};
  close(signal) {
    if (this.#closed) return Promise.resolve();
    if (this.#closing) return this.#closing;
    this.#closing = this.#close(signal).finally(() => {
      this.#closing = void 0;
    });
    return this.#closing;
  }
  async #close(signal) {
    try {
      await submitRfbInputRelease(this.gate, this.socket, signal).catch(() => {});
    } finally {
      const closed = this.socket.closed
        ? Promise.resolve()
        : new Promise((resolve) => this.socket.once('close', resolve));
      this.socket.destroy();
      this.gate.dispose();
      await closed;
      this.#closed = true;
    }
  }
};

// mar-node/src/remote-desktop/tigervnc-rfb-session.ts
var TigerVncSetupCleanupError = class extends RemoteDesktopError {
  constructor(code2, attachment) {
    super(code2);
    this.attachment = attachment;
    this.name = 'TigerVncSetupCleanupError';
  }
  attachment;
  retryCleanup(signal) {
    return this.attachment.close(signal);
  }
};
var TigerVncRfbSession = class _TigerVncRfbSession {
  constructor(options, socket, gate, attachment) {
    this.options = options;
    this.socket = socket;
    this.gate = gate;
    this.attachment = attachment;
  }
  options;
  socket;
  gate;
  attachment;
  #closed = false;
  #failed = false;
  #detached = false;
  #closing;
  /** Called only after the surrounding Server authorization has accepted OPEN. */
  static async open(options, signal) {
    const setup = new AbortController();
    const deadline = AbortSignal.any([signal, setup.signal, AbortSignal.timeout(1e4)]);
    const frontendFailed = () => setup.abort();
    options.frontend.pause();
    options.frontend.on('error', frontendFailed);
    options.frontend.once('close', frontendFailed);
    options.frontend.once('end', frontendFailed);
    let attachment;
    let socket;
    let gateFailure;
    try {
      const connected = await options.backend.connect(options.maxPixels, deadline);
      socket = connected.socket;
      if (!options.isCurrentTopology(connected.init.width, connected.init.height))
        throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
      let session;
      const gate = new RfbClientGate(
        socket,
        options.mode,
        () =>
          options.isCurrentTopology(connected.init.width, connected.init.height) &&
          options.isControlOwner(),
        (code2) => {
          if (session) session.#fail(code2);
          else {
            gateFailure = code2;
            setup.abort();
          }
        }
      );
      attachment = new StandardRfbAttachment(socket, gate);
      if (gateFailure) throw new RemoteDesktopError(gateFailure);
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      if (!options.isCurrentTopology(connected.init.width, connected.init.height))
        throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
      options.onAttached();
      await handshakeRfbFrontend(options.frontend, connected.init.serverInit, deadline);
      if (gateFailure) throw new RemoteDesktopError(gateFailure);
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      if (!options.isCurrentTopology(connected.init.width, connected.init.height))
        throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
      session = new _TigerVncRfbSession(options, socket, gate, attachment);
      session.#start();
      return session;
    } catch (error) {
      const ignore = () => {};
      if (!options.frontend.closed) {
        options.frontend.on('error', ignore);
        options.frontend.once('close', () => options.frontend.off('error', ignore));
      }
      options.frontend.destroy();
      if (attachment) {
        try {
          await attachment.close(AbortSignal.timeout(5e3));
        } catch (cleanupError) {
          throw new TigerVncSetupCleanupError(
            cleanupError instanceof RemoteDesktopError
              ? cleanupError.code
              : 'DESKTOP_NATIVE_CLEANUP_FAILED',
            attachment
          );
        }
      } else if (socket) {
        if (!socket.closed) {
          socket.on('error', ignore);
          socket.once('close', () => socket?.off('error', ignore));
        }
        socket.destroy();
      }
      if (gateFailure) throw new RemoteDesktopError(gateFailure);
      if (error instanceof RemoteDesktopError) throw error;
      throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
    } finally {
      options.frontend.off('error', frontendFailed);
      options.frontend.off('close', frontendFailed);
      options.frontend.off('end', frontendFailed);
    }
  }
  /** Synchronously stop frontend input and output before attachment cleanup. */
  fence() {
    if (this.#closed || this.#closing) return;
    void this.gate.fence().catch(() => {});
    this.#detach();
  }
  /** Fence input and await this backend's attachment cleanup contract. */
  close(signal) {
    if (this.#closed) return Promise.resolve();
    if (this.#closing) return this.#closing;
    this.fence();
    const pending = this.attachment.close(signal).then(() => {
      this.#closed = true;
    });
    this.#closing = pending.finally(() => {
      this.#closing = void 0;
    });
    return this.#closing;
  }
  #start() {
    this.options.frontend.on('data', this.#input);
    this.options.frontend.on('error', this.#transportFailed);
    this.options.frontend.on('end', this.#transportFailed);
    this.options.frontend.on('close', this.#transportFailed);
    this.socket.on('end', this.#transportFailed);
    this.socket.on('close', this.#transportFailed);
    this.socket.pipe(this.options.frontend, { end: false });
    this.options.frontend.resume();
  }
  #input = (data) => {
    if (!(data instanceof Uint8Array)) this.#fail('DESKTOP_RFB_INVALID');
    else this.gate.receive(data);
  };
  #transportFailed = () => this.#fail('DESKTOP_TRANSPORT_ERROR');
  #fail(code2) {
    if (this.#failed || this.#closed || this.#closing) return;
    this.#failed = true;
    void this.gate.fence().catch(() => {});
    this.#detach();
    try {
      this.options.onFailure(code2);
    } catch {}
    void this.close(AbortSignal.timeout(5e3)).catch(() => {});
  }
  #detach() {
    if (this.#detached) return;
    this.#detached = true;
    this.options.frontend.pause();
    this.options.frontend.off('data', this.#input);
    this.options.frontend.off('error', this.#transportFailed);
    this.options.frontend.off('end', this.#transportFailed);
    this.options.frontend.off('close', this.#transportFailed);
    this.socket.off('end', this.#transportFailed);
    this.socket.off('close', this.#transportFailed);
    this.socket.unpipe(this.options.frontend);
    const ignore = () => {};
    if (!this.options.frontend.closed) {
      this.options.frontend.on('error', ignore);
      this.options.frontend.once('close', () => this.options.frontend.off('error', ignore));
    }
    this.options.frontend.destroy();
  }
};

// mar-node/src/remote-desktop/remote-desktop-attachment.ts
var RemoteDesktopAttachment = class {
  constructor(options) {
    this.options = options;
    if (!options.attachmentId) throw new RemoteDesktopError('DESKTOP_BACKEND_CONFIG_INVALID');
  }
  options;
  #state = 'new';
  #session;
  #pendingCleanup;
  #opening;
  #closing;
  #closeRequested = false;
  #cancel = new AbortController();
  open(signal) {
    if (this.#state !== 'new') return Promise.reject(new RemoteDesktopError('DESKTOP_RFB_CLOSED'));
    if (signal.aborted) return Promise.reject(new RemoteDesktopError('DESKTOP_SETUP_CANCELLED'));
    this.#state = 'opening';
    this.#opening = this.#start(AbortSignal.any([signal, this.#cancel.signal]));
    return this.#opening;
  }
  close(signal) {
    if (this.#state === 'closed') return Promise.resolve();
    if (this.#closing) return this.#closing;
    this.#closeRequested = true;
    this.#state = 'cleanup';
    this.#cancel.abort();
    if (this.#session) this.#session.fence();
    else this.options.frontend.destroy();
    this.#closing = (async () => {
      await this.#opening?.catch(() => {});
      await this.#finishCleanup(signal);
      this.#state = 'closed';
    })().finally(() => {
      this.#closing = void 0;
    });
    return this.#closing;
  }
  async #start(signal) {
    try {
      this.#session = await TigerVncRfbSession.open(
        {
          ...this.options,
          isControlOwner: () => !this.#closeRequested,
          onFailure: (code2) => {
            void this.close(AbortSignal.timeout(5e3)).catch(() => {});
            this.options.onFailure(code2);
          }
        },
        signal
      );
      if (this.#closeRequested || signal.aborted)
        throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      this.#state = 'active';
    } catch (error) {
      if (error instanceof TigerVncSetupCleanupError) {
        this.#pendingCleanup = error;
        this.#state = 'cleanup';
        throw error;
      }
      try {
        await this.#finishCleanup(AbortSignal.timeout(5e3));
        this.#state = 'closed';
      } catch (cleanupError) {
        this.#state = 'cleanup';
        throw cleanupError;
      }
      throw error;
    }
  }
  async #finishCleanup(signal) {
    if (this.#session) await this.#session.close(signal);
    if (this.#pendingCleanup) await this.#pendingCleanup.retryCleanup(signal);
    this.#session = void 0;
    this.#pendingCleanup = void 0;
  }
};

// mar-node/src/remote-desktop/tigervnc-backend-pool.ts
var TigerVncBackendPool = class {
  constructor(start, onFailure) {
    this.start = start;
    this.onFailure = onFailure;
  }
  start;
  onFailure;
  #tail = Promise.resolve();
  #backend;
  #generation = 0;
  #unavailable = false;
  #retiring = false;
  #references = /* @__PURE__ */ new Set();
  #disposed = false;
  /** Used alongside the native-session and topology checks when admitting input. */
  isAvailable() {
    return !this.#disposed && !this.#unavailable && !this.#retiring;
  }
  acquire(signal) {
    return this.#serialize(async () => {
      if (signal.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      if (this.#disposed || this.#unavailable || this.#retiring)
        throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
      if (!this.#backend) {
        const generation = ++this.#generation;
        const backend2 = await this.start(signal, () => {
          if (generation !== this.#generation || this.#unavailable) return;
          this.#unavailable = true;
          try {
            this.onFailure();
          } catch {}
        });
        this.#backend = backend2;
        if (signal.aborted || this.#unavailable || this.#disposed) {
          await this.#stopEmpty();
          throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
        }
      }
      const backend = this.#backend;
      const token = /* @__PURE__ */ Symbol();
      this.#references.add(token);
      return {
        backend,
        release: () => this.#serialize(() => this.#release(token))
      };
    });
  }
  /** Disallow new references; existing owners still close their own connections. */
  dispose() {
    this.#disposed = true;
    return this.#serialize(async () => {
      if (this.#references.size) throw new RemoteDesktopError('DESKTOP_NATIVE_ATTACHMENTS_ACTIVE');
      await this.#stopEmpty();
    });
  }
  async #release(token) {
    if (!this.#references.has(token)) return;
    if (this.#references.size === 1) {
      await this.#stopEmpty();
    }
    this.#references.delete(token);
  }
  async #stopEmpty() {
    if (!this.#backend) return;
    this.#retiring = true;
    await this.#backend.stop();
    this.#backend = void 0;
    this.#unavailable = false;
    this.#retiring = false;
    ++this.#generation;
  }
  #serialize(operation) {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
};

// mar-node/src/remote-desktop/ultravnc-managed-process.ts
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// mar-node/src/remote-desktop/rfb-backend-handshake.ts
import { createCipheriv } from 'node:crypto';
async function handshakeRfbBackend(stream, password, maxPixels, signal) {
  const io = new RfbHandshakeIo(stream, signal);
  try {
    if (
      password.length < 1 ||
      password.length > 8 ||
      password.includes(0) ||
      !Number.isSafeInteger(maxPixels) ||
      maxPixels < 1
    )
      throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    if (!(await io.read(12)).equals(Buffer.from('RFB 003.008\n')))
      throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    await io.write(Buffer.from('RFB 003.008\n'));
    const securityCount = (await io.read(1))[0];
    if (securityCount === 0 || !(await io.read(securityCount)).includes(2))
      throw new RemoteDesktopError('DESKTOP_BACKEND_AUTH_UNAVAILABLE');
    await io.write(Buffer.from([2]));
    const challenge = await io.read(16);
    const response = vncResponse(challenge, password);
    try {
      await io.write(response);
    } finally {
      response.fill(0);
      challenge.fill(0);
    }
    if ((await io.read(4)).readUInt32BE() !== 0)
      throw new RemoteDesktopError('DESKTOP_BACKEND_AUTH_FAILED');
    await io.write(Buffer.from([1]));
    const header = await io.read(24);
    const width = header.readUInt16BE(0);
    const height = header.readUInt16BE(2);
    const nameLength = header.readUInt32BE(20);
    if (
      width === 0 ||
      height === 0 ||
      width * height > maxPixels ||
      nameLength > 4096 ||
      !validPixelFormat(header.subarray(4, 20))
    )
      throw new RemoteDesktopError('DESKTOP_RFB_INVALID');
    const name = await io.read(nameLength);
    return { width, height, serverInit: Buffer.concat([header, name]) };
  } catch (error) {
    stream.destroy();
    if (error instanceof RemoteDesktopError) throw error;
    throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
  } finally {
    io.dispose();
  }
}
function vncResponse(challenge, password) {
  const key = Buffer.alloc(8);
  for (let i = 0; i < password.length; i++) {
    let byte = password[i];
    byte = ((byte & 85) << 1) | ((byte >>> 1) & 85);
    byte = ((byte & 51) << 2) | ((byte >>> 2) & 51);
    key[i] = ((byte & 15) << 4) | (byte >>> 4);
  }
  const expanded = Buffer.concat([key, key, key]);
  try {
    const cipher = createCipheriv('des-ede3', expanded, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(challenge), cipher.final()]);
  } finally {
    key.fill(0);
    expanded.fill(0);
  }
}
function validPixelFormat(format) {
  const bpp = format[0];
  const depth = format[1];
  if (![8, 16, 32].includes(bpp) || depth === 0 || depth > bpp || format[2] > 1 || format[3] !== 1)
    return false;
  let occupied = 0n;
  for (let i = 0; i < 3; i++) {
    const max = format.readUInt16BE(4 + i * 2);
    const shift = format[10 + i];
    if (max === 0 || (max & (max + 1)) !== 0) return false;
    const mask = BigInt(max) << BigInt(shift);
    if (mask >= 1n << BigInt(bpp) || (mask & occupied) !== 0n) return false;
    occupied |= mask;
  }
  return true;
}

// mar-node/src/remote-desktop/ultravnc-config.ts
import { createCipheriv as createCipheriv2 } from 'node:crypto';
function ultraVncProfilePassword(password) {
  if (password.length !== 8 || password.includes(0))
    throw new Error('DESKTOP_BACKEND_CONFIG_INVALID');
  const key = Buffer.from('e84ad660c4721ae0'.repeat(3), 'hex');
  try {
    const cipher = createCipheriv2('des-ede3', key, null);
    cipher.setAutoPadding(false);
    const encoded = Buffer.concat([cipher.update(password), cipher.final()]);
    try {
      const checksum = encoded.reduce((sum, byte) => (sum + byte) & 255, 0);
      return Buffer.concat([encoded, Buffer.from([checksum])]).toString('hex');
    } finally {
      encoded.fill(0);
    }
  } finally {
    key.fill(0);
  }
}
function ultraVncConfig(port2, password) {
  if (!Number.isInteger(port2) || port2 < 1 || port2 > 65535)
    throw new Error('DESKTOP_BACKEND_CONFIG_INVALID');
  return [
    '[admin]',
    'LoopbackOnly=1',
    'AllowLoopback=1',
    'AuthRequired=1',
    'SocketConnect=1',
    'HTTPConnect=0',
    'UseIpv6=0',
    'AutoPortSelect=0',
    `PortNumber=${port2}`,
    'InputsEnabled=1',
    'QuerySetting=0',
    'FileTransferEnabled=0',
    'secondary=1',
    '[UltraVNC]',
    `passwd=${ultraVncProfilePassword(password)}`,
    ''
  ].join('\r\n');
}

// mar-node/src/remote-desktop/ultravnc-managed-process.ts
var UltraVncManagedProcess = class _UltraVncManagedProcess {
  constructor(child, directory, port2, secret, onUnexpectedExit) {
    this.child = child;
    this.directory = directory;
    this.port = port2;
    this.secret = secret;
    this.onUnexpectedExit = onUnexpectedExit;
    child.on('error', () => {});
    child.stderr?.resume();
    this.#exited = new Promise((resolve) => {
      child.once('close', () => {
        this.#didExit = true;
        if (this.#ready && !this.#stopping) {
          try {
            this.onUnexpectedExit();
          } catch {}
        }
        resolve();
      });
    });
  }
  child;
  directory;
  port;
  secret;
  onUnexpectedExit;
  #connections = /* @__PURE__ */ new Set();
  #exited;
  #stopping = false;
  #ready = false;
  #didExit = false;
  #stopPromise;
  static async start(options, signal) {
    if (process.platform !== 'win32' || !isAbsolute(options.binaryPath))
      throw new RemoteDesktopError('DESKTOP_BACKEND_CONFIG_INVALID');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(1e4)]);
    if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
    const directory = await mkdtemp(join(tmpdir(), 'mar-ultravnc-'));
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const secret = randomBytes(8);
    for (let i = 0; i < secret.length; i++) secret[i] = alphabet.charCodeAt(secret[i] & 63);
    let backend;
    try {
      const port2 = await availableLoopbackPort();
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      const config = join(directory, 'ultravnc.ini');
      await writeFile(config, ultraVncConfig(port2, secret), { flag: 'wx', mode: 384 });
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      const child = spawn(options.binaryPath, ['-run', '-multi', '-config', config], {
        cwd: dirname(options.binaryPath),
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      });
      backend = new _UltraVncManagedProcess(
        child,
        directory,
        port2,
        secret,
        options.onUnexpectedExit
      );
      while (!deadline.aborted && !backend.#didExit) {
        try {
          const connection = await backend.connect(64 * 1024 * 1024, deadline);
          connection.socket.destroy();
          if (backend.#didExit || deadline.aborted)
            throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
          backend.#ready = true;
          return backend;
        } catch (error) {
          if (deadline.aborted || backend.#didExit) throw error;
          await delay(50, void 0, { signal: deadline });
        }
      }
      throw new RemoteDesktopError('DESKTOP_BACKEND_START_FAILED');
    } catch (error) {
      if (backend) await backend.stop();
      else {
        secret.fill(0);
        await rm(directory, { recursive: true, force: true });
      }
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      if (error instanceof RemoteDesktopError) throw error;
      throw new RemoteDesktopError('DESKTOP_BACKEND_START_FAILED');
    }
  }
  async connect(maxPixels, signal) {
    if (this.#stopping || this.#didExit) throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    const socket = connect({ host: '127.0.0.1', port: this.port });
    this.#connections.add(socket);
    socket.once('close', () => this.#connections.delete(socket));
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          socket.off('connect', connected);
          socket.off('error', failed);
          signal.removeEventListener('abort', aborted);
        };
        const connected = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(new RemoteDesktopError('DESKTOP_BACKEND_CLOSED'));
        };
        const aborted = () => {
          cleanup();
          reject(new RemoteDesktopError('DESKTOP_SETUP_CANCELLED'));
        };
        socket.once('connect', connected);
        socket.once('error', failed);
        if (signal.aborted) aborted();
        else signal.addEventListener('abort', aborted, { once: true });
      });
      const init = await handshakeRfbBackend(socket, this.secret, maxPixels, signal);
      return { socket, init };
    } catch (error) {
      socket.on('error', () => {});
      socket.destroy();
      throw error;
    }
  }
  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    this.#stopPromise = (async () => {
      for (const socket of this.#connections) socket.destroy();
      if (!this.#didExit) this.child.kill();
      const exited = await Promise.race([
        this.#exited.then(() => true),
        delay(5e3, void 0, { ref: false }).then(() => false)
      ]);
      if (!exited) throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
      this.secret.fill(0);
      await rm(this.directory, { recursive: true, force: true });
    })().catch((error) => {
      this.#stopPromise = void 0;
      throw error;
    });
    return this.#stopPromise;
  }
};
async function availableLoopbackPort() {
  const listener = createServer();
  return new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string')
        return listener.close(() => reject(new Error('port')));
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

// mar-node/src/remote-desktop/windows-remote-desktop-runtime.ts
var run = promisify(execFile);
var SCREEN_QUERY = `
$ErrorActionPreference = "Stop"
if (-not [Environment]::UserInteractive) { exit 2 }
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  @{ name=$_.DeviceName; primary=$_.Primary; x=$_.Bounds.X; y=$_.Bounds.Y;
     width=$_.Bounds.Width; height=$_.Bounds.Height }
})
ConvertTo-Json -InputObject $screens -Compress
`;
function windowsDesktopLayout(screens, generation, revision2) {
  if (!screens.length) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
  const minX = Math.min(...screens.map((screen) => screen.x));
  const minY = Math.min(...screens.map((screen) => screen.y));
  const maxX = Math.max(...screens.map((screen) => screen.x + screen.width));
  const maxY = Math.max(...screens.map((screen) => screen.y + screen.height));
  const result = remoteDesktopDescriptionSchema.safeParse({
    desktopGeneration: generation,
    topologyRevision: revision2,
    framebuffer: { width: maxX - minX, height: maxY - minY },
    displays: screens.map((screen) => ({
      displayId: Buffer.from(screen.name, 'utf8').toString('base64url').padEnd(8, '_'),
      name: screen.name,
      primary: screen.primary,
      nativeBounds: { x: screen.x, y: screen.y, width: screen.width, height: screen.height },
      framebufferBounds: {
        x: screen.x - minX,
        y: screen.y - minY,
        width: screen.width,
        height: screen.height
      },
      nativeToFramebuffer: [1, 0, 0, 1, minX === 0 ? 0 : -minX, minY === 0 ? 0 : -minY]
    }))
  });
  if (!result.success) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
  return result.data;
}
async function queryScreens(signal) {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', SCREEN_QUERY],
    {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      signal
    }
  );
  return JSON.parse(stdout);
}
var WindowsRemoteDesktopRuntime = class _WindowsRemoteDesktopRuntime {
  constructor(options) {
    this.options = options;
    this.#pool = new TigerVncBackendPool(
      (signal, onUnexpectedExit) =>
        UltraVncManagedProcess.start({ binaryPath: options.binaryPath, onUnexpectedExit }, signal),
      () => options.fence('DESKTOP_BACKEND_CLOSED')
    );
  }
  options;
  #pool;
  #generation = randomUUID();
  #layout;
  #signature = '';
  #revision = 0;
  #disposed = false;
  static async start(options, signal) {
    const runtime2 = new _WindowsRemoteDesktopRuntime(options);
    await runtime2.refresh(signal);
    return runtime2;
  }
  async refresh(signal) {
    const screens = (await queryScreens(signal)).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    const signature = JSON.stringify(
      screens.map((screen) => [
        screen.name,
        screen.primary,
        screen.x,
        screen.y,
        screen.width,
        screen.height
      ])
    );
    if (this.#disposed) throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    if (signature === this.#signature) return;
    const layout = windowsDesktopLayout(screens, this.#generation, this.#revision + 1);
    if (layout.framebuffer.width * layout.framebuffer.height > this.options.maxPixels)
      throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
    if (this.#layout) this.options.fence('DESKTOP_TOPOLOGY_UNAVAILABLE');
    this.#signature = signature;
    this.#revision++;
    this.#layout = layout;
  }
  describe() {
    if (this.#disposed || !this.#layout || !this.#pool.isAvailable())
      throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    return structuredClone(this.#layout);
  }
  isCurrent = (command) =>
    !this.#disposed &&
    this.#pool.isAvailable() &&
    !!this.#layout &&
    this.#layout.desktopGeneration === command.desktopGeneration &&
    this.#layout.topologyRevision === command.topologyRevision;
  createAttachment = (command, frontend, callbacks) =>
    new PooledDesktopAttachment(
      this.#pool,
      frontend,
      (backend) =>
        new RemoteDesktopAttachment({
          attachmentId: command.attachmentId,
          frontend,
          backend,
          mode: command.mode,
          maxPixels: this.options.maxPixels,
          isCurrentTopology: (width, height) =>
            this.isCurrent(command) &&
            this.#layout?.framebuffer.width === width &&
            this.#layout.framebuffer.height === height,
          onAttached: callbacks.attached,
          onFailure: callbacks.failed
        })
    );
  async dispose() {
    if (!this.#disposed) {
      this.#disposed = true;
      this.options.fence('DESKTOP_SESSION_UNAVAILABLE');
    }
    await this.#pool.dispose();
  }
};

// mar-node/test/runs/windows-runtime-probe.6LPn12YM/probe.ts
var [binaryPath, port] = process.argv.slice(2);
if (!binaryPath || !port) throw new Error('Missing test arguments');
var runtime = await WindowsRemoteDesktopRuntime.start(
  { binaryPath, maxPixels: 67108864, fence: (code2) => console.log('fence', code2) },
  AbortSignal.timeout(2e4)
);
var desktop = runtime.describe();
console.log('TOPOLOGY', JSON.stringify(desktop));
var server = createServer2((socket) => {
  const attachment = runtime.createAttachment(
    {
      attachmentId: 'probe-attachment',
      mode: 'CONTROL',
      desktopGeneration: desktop.desktopGeneration,
      topologyRevision: desktop.topologyRevision
    },
    socket,
    { attached: () => console.log('ATTACHED'), failed: (code2) => console.error('FAILED', code2) }
  );
  let closing = false;
  const finish = async () => {
    if (closing) return;
    closing = true;
    try {
      await attachment.close(AbortSignal.timeout(1e4));
      await runtime.dispose();
      server.close();
      console.log('CLOSED');
    } catch (e) {
      console.error(e);
      process.exitCode = 1;
      server.close();
    }
  };
  socket.once('close', () => void finish());
  void attachment.open(AbortSignal.timeout(2e4)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
    void finish();
  });
});
server.listen(Number(port), '127.0.0.1', () => console.log('READY'));

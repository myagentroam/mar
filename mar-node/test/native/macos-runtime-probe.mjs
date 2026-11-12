var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name2 in all) __defProp(target, name2, { get: all[name2], enumerable: true });
};

// test/runs/macos-managed-runtime-probe/probe.ts
import { createServer as createServer2 } from 'node:net';

// mar-node/src/remote-desktop/macos-remote-desktop-runtime.ts
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
  const { data, path: path2, errorMaps, issueData } = params;
  const fullPath = [...path2, ...(issueData.path || [])];
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
  constructor(parent, value, path2, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path2;
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

// packages/protocol/dist/model-usage.js
var MODEL_USAGE_RETENTION_MS = 90 * 864e5;
var MODEL_USAGE_OUTBOX_RETENTION_MS = 7 * 864e5;
var MODEL_USAGE_BATCH_LIMIT = 64;
var identifier = external_exports.string().min(1).max(256);
var time = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var usageCountSchema = external_exports.string().regex(/^(0|[1-9][0-9]{0,37})$/);
var usageRunnerSchema = external_exports.enum(['mar-agent', 'codex', 'claude-code', 'opencode']);
var usagePurposeSchema = external_exports.enum([
  'conversation',
  'compact',
  'title',
  'prompt_completion',
  'other'
]);
var modelUsageCapabilitySchema = external_exports
  .object({ apiVersion: external_exports.literal(1) })
  .strict();
var modelUsageGrantClaimsSchema = external_exports
  .object({
    audience: external_exports.literal('model-usage-v1'),
    scopeId: external_exports.string().uuid(),
    nodeId: identifier,
    userId: external_exports.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mode: external_exports.enum(['work', 'conversation']),
    issuedAt: time,
    expiresAt: time
  })
  .strict();
var modelUsageGrantSchema = external_exports
  .object({
    scopeId: external_exports.string().uuid(),
    token: external_exports.string().min(1).max(2048)
  })
  .strict();
var modelUsageRecordSchema = external_exports
  .object({
    schemaVersion: external_exports.literal(1),
    recordId: identifier,
    requestId: identifier,
    revision: external_exports.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    scopeId: external_exports.string().uuid(),
    runner: usageRunnerSchema,
    sessionId: identifier,
    runId: identifier,
    modelConfigurationId: identifier.optional(),
    modelName: identifier.optional(),
    provider: identifier.optional(),
    requestedModel: identifier.optional(),
    actualModel: identifier.optional(),
    responseId: identifier.optional(),
    purpose: usagePurposeSchema,
    agentRole: external_exports.enum(['root', 'subagent']),
    startedAt: time,
    endedAt: time.optional(),
    state: external_exports.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    inputTokens: usageCountSchema.optional(),
    outputTokens: usageCountSchema.optional(),
    cacheReadTokens: usageCountSchema.optional(),
    cacheWriteTokens: usageCountSchema.optional(),
    reasoningTokens: usageCountSchema.optional(),
    coverage: external_exports.enum(['request', 'partial']).default('request')
  })
  .strict()
  .superRefine((record, context) => {
    if ((record.state === 'running') !== (record.endedAt === void 0))
      context.addIssue({ code: 'custom', message: 'Usage outcome and end time do not match.' });
    if (record.endedAt !== void 0 && record.endedAt < record.startedAt)
      context.addIssue({ code: 'custom', message: 'Usage end time precedes its start.' });
  });
var modelUsageBatchSchema = external_exports
  .object({
    apiVersion: external_exports.literal(1),
    entries: external_exports
      .array(
        external_exports
          .object({ grant: modelUsageGrantSchema, record: modelUsageRecordSchema })
          .strict()
      )
      .min(1)
      .max(MODEL_USAGE_BATCH_LIMIT)
  })
  .strict();
var modelUsageAckSchema = external_exports
  .object({
    apiVersion: external_exports.literal(1),
    results: external_exports
      .array(
        external_exports
          .object({
            recordId: identifier,
            revision: external_exports.number().int().positive(),
            status: external_exports.enum(['accepted', 'rejected']),
            code: external_exports
              .enum([
                'USAGE_GRANT_INVALID',
                'USAGE_EXPIRED',
                'USAGE_USER_DELETED',
                'USAGE_CONFLICT',
                'USAGE_TIME_INVALID'
              ])
              .optional()
          })
          .strict()
      )
      .max(MODEL_USAGE_BATCH_LIMIT)
  })
  .strict();
var personalUsageQuerySchema = external_exports
  .object({
    from: external_exports.coerce.number().int().nonnegative(),
    to: external_exports.coerce.number().int().nonnegative(),
    timeZone: external_exports
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    runner: usageRunnerSchema.optional(),
    model: external_exports.string().min(1).max(800).optional(),
    mode: external_exports.enum(['work', 'conversation']).optional(),
    purpose: usagePurposeSchema.optional()
  })
  .strict()
  .refine((value) => value.to > value.from && value.to - value.from <= MODEL_USAGE_RETENTION_MS, {
    message: 'Usage range must be positive and no longer than 90 days.'
  });
var personalUsagePageSchema = external_exports.coerce
  .number()
  .int()
  .min(1)
  .max(Math.floor(Number.MAX_SAFE_INTEGER / 20));

// packages/protocol/dist/git-identity.js
var cleanLine = external_exports
  .string()
  .trim()
  .max(256)
  .refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
var personalGitIdentitySchema = external_exports
  .object({
    name: cleanLine.refine((value) => !/[<>]/u.test(value)),
    email: cleanLine.refine((value) => value === '' || /^[^\s<>@]+@[^\s<>@]+$/u.test(value))
  })
  .strict()
  .refine((value) => Boolean(value.name) === Boolean(value.email));
function normalizeGitHost(value) {
  const host = value.toLowerCase();
  if (!host || /[\s/@\\?#*%]/u.test(host) || host.startsWith('-'))
    throw new Error('GIT_CONFIGURATION_INVALID');
  const parsed = new URL(`https://${host}`);
  if (parsed.port || parsed.username || parsed.password || parsed.hostname !== host)
    throw new Error('GIT_CONFIGURATION_INVALID');
  return host;
}
function normalizeGitPath(value) {
  const path2 = value.replace(/^\/+|\/+$/gu, '');
  if (
    // eslint-disable-next-line no-control-regex -- Reject control characters in repository scopes.
    /[\x00-\x1f\x7f\\]/u.test(path2) ||
    (path2 !== '' && path2.split('/').some((part) => part === '' || part === '.' || part === '..'))
  )
    throw new Error('GIT_CONFIGURATION_INVALID');
  return path2;
}
var hostSchema = cleanLine
  .refine((value) => value.length > 0)
  .transform((value, context) => {
    try {
      return normalizeGitHost(value);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Enter a host without a protocol, port or path.'
      });
      return external_exports.NEVER;
    }
  });
var pathSchema = external_exports
  .string()
  .trim()
  .max(2048)
  .transform((value, context) => {
    try {
      return normalizeGitPath(value);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Enter a repository path without traversal or empty segments.'
      });
      return external_exports.NEVER;
    }
  });
var secretSchema = external_exports
  .string()
  .min(1)
  .max(32768)
  .refine((value) => !value.includes('\0'));
var passphraseSchema = external_exports
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0') && !/[\r\n]/u.test(value));
var credentialFields = {
  name: cleanLine.refine((value) => value.length > 0),
  protocol: external_exports.enum(['HTTPS', 'SSH']),
  host: hostSchema,
  port: external_exports.number().int().min(1).max(65535),
  pathPrefix: pathSchema,
  username: cleanLine.refine((value) => value.length > 0),
  commitName: cleanLine.refine((value) => !/[<>]/u.test(value)),
  commitEmail: cleanLine.refine((value) => value === '' || /^[^\s<>@]+@[^\s<>@]+$/u.test(value))
};
function credentialIssues(value, context) {
  if (value.protocol === 'HTTPS') {
    if (value.passphrase !== void 0)
      context.addIssue({
        code: 'custom',
        path: ['passphrase'],
        message: 'HTTPS credentials cannot include an SSH passphrase.'
      });
    if (value.secret !== void 0 && /[\r\n]/u.test(value.secret))
      context.addIssue({
        code: 'custom',
        path: ['secret'],
        message: 'Enter a single-line HTTPS password.'
      });
  }
  if (value.protocol === 'SSH') {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/u.test(value.username))
      context.addIssue({
        code: 'custom',
        path: ['username'],
        message: 'Enter a valid SSH username.'
      });
    if (
      value.secret !== void 0 &&
      !/^-----BEGIN (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----\r?\n/u.test(value.secret)
    )
      context.addIssue({
        code: 'custom',
        path: ['secret'],
        message: 'Enter a PEM or OpenSSH private key.'
      });
  }
  if (
    value.commitName !== void 0 &&
    value.commitEmail !== void 0 &&
    Boolean(value.commitName) !== Boolean(value.commitEmail)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['commitName'],
      message: 'Set or clear the commit name and email together.'
    });
    context.addIssue({
      code: 'custom',
      path: ['commitEmail'],
      message: 'Set or clear the commit name and email together.'
    });
  }
}
var gitCredentialInputSchema = external_exports
  .object({
    ...credentialFields,
    secret: secretSchema,
    passphrase: passphraseSchema.optional()
  })
  .strict()
  .superRefine(credentialIssues);
var gitCredentialUpdateSchema = external_exports
  .object({
    ...credentialFields,
    secret: secretSchema.optional(),
    passphrase: passphraseSchema.nullable().optional()
  })
  .strict()
  .superRefine(credentialIssues);
var gitCredentialSchema = external_exports
  .object({
    ...credentialFields,
    id: external_exports.string().min(1).max(128),
    secret: secretSchema,
    passphrase: passphraseSchema.optional()
  })
  .strict()
  .superRefine(credentialIssues);
var gitCredentialSummarySchema = external_exports
  .object({
    ...credentialFields,
    id: external_exports.string().min(1).max(128),
    hasSecret: external_exports.boolean(),
    hasPassphrase: external_exports.boolean()
  })
  .strict()
  .superRefine(credentialIssues);
var personalGitRuntimeSchema = external_exports
  .object({
    credentials: external_exports.array(gitCredentialSchema).max(64)
  })
  .strict()
  .superRefine((value, context) => {
    const scopes = value.credentials.map(gitCredentialScopeKey);
    if (
      new Set(scopes).size !== scopes.length ||
      new Set(value.credentials.map((entry) => entry.id)).size !== value.credentials.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Credential IDs and matching scopes must be unique.'
      });
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024)
      context.addIssue({ code: 'custom', message: 'Git configuration exceeds the size limit.' });
  });
var personalGitSummarySchema = external_exports
  .object({
    credentials: external_exports.array(gitCredentialSummarySchema).max(64)
  })
  .strict();
var workspaceGitSettingsSchema = external_exports
  .object({
    preserveGitConfig: external_exports.boolean(),
    includeParentRepository: external_exports.boolean().optional()
  })
  .strict();
function gitCredentialScopeKey(credential) {
  return JSON.stringify([
    credential.protocol,
    credential.host,
    credential.port,
    credential.pathPrefix
  ]);
}

// packages/protocol/dist/tool-result-resource.js
var toolResultResourceInputSchema = external_exports
  .object({
    resourceRef: external_exports.string().uuid(),
    cursor: external_exports.string().min(1).max(1024).optional(),
    maxBytes: external_exports
      .number()
      .int()
      .min(4)
      .max(256 * 1024)
      .optional()
  })
  .strict();
var toolResultResourcePageSchema = external_exports
  .object({
    resourceRef: external_exports.string().uuid(),
    type: external_exports.literal('file_changes'),
    version: external_exports.literal(1),
    format: external_exports.literal('unified-diff'),
    sha256: external_exports.string().regex(/^[a-f0-9]{64}$/u),
    byteSize: external_exports
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
    content: external_exports
      .string()
      .max(256 * 1024)
      .refine((value) => new TextEncoder().encode(value).byteLength <= 256 * 1024, {
        message: 'Content must not exceed 256 KiB in UTF-8 bytes'
      }),
    nextCursor: external_exports.string().min(1).max(1024).optional()
  })
  .strict();
var fileChangeDiffSchema = external_exports.discriminatedUnion('status', [
  external_exports
    .object({
      status: external_exports.literal('available'),
      source: external_exports.literal('TOOL_CHANGE'),
      resourceRef: external_exports.string().uuid(),
      format: external_exports.literal('unified-diff'),
      byteSize: external_exports
        .number()
        .int()
        .min(0)
        .max(16 * 1024 * 1024),
      sha256: external_exports.string().regex(/^[a-f0-9]{64}$/u)
    })
    .strict(),
  external_exports
    .object({
      status: external_exports.literal('unavailable'),
      reason: external_exports.enum([
        'binary',
        'limit-exceeded',
        'capture-failed',
        'storage-failed'
      ])
    })
    .strict()
]);

// packages/protocol/dist/enterprise.js
var editionSchema = external_exports.enum(['PERSONAL', 'ENTERPRISE']);
var licenseStateSchema = external_exports.enum([
  'PERSONAL',
  'ENTERPRISE_VALID',
  'ENTERPRISE_FROZEN'
]);
var userRoleSchema = external_exports.enum(['ADMIN', 'ORG_ADMIN', 'MEMBER']);
var permissionScopeSchema = external_exports.enum([
  'SYSTEM',
  'ORG_SUBTREE',
  'PERSONAL',
  'GRANTED_RESOURCE'
]);
var enterpriseCapabilitySchema = external_exports
  .object({
    edition: editionSchema,
    licenseState: licenseStateSchema,
    role: userRoleSchema.nullable(),
    organizationId: external_exports.number().int().positive().nullable(),
    managementWritable: external_exports.boolean()
  })
  .strict();
var organizationSchema = external_exports
  .object({
    id: external_exports.number().int().positive(),
    name: external_exports.string().trim().min(1).max(128),
    parentOrganizationId: external_exports.number().int().positive().nullable(),
    createdAt: external_exports.number().int().nonnegative(),
    updatedAt: external_exports.number().int().nonnegative()
  })
  .strict();
var resourceOwnershipSchema = external_exports.discriminatedUnion('ownerType', [
  external_exports
    .object({
      ownerType: external_exports.literal('PERSONAL'),
      ownerUserId: external_exports.number().int().positive()
    })
    .strict(),
  external_exports
    .object({
      ownerType: external_exports.literal('ORGANIZATION'),
      ownerOrganizationId: external_exports.number().int().positive()
    })
    .strict()
]);
var resourceGrantSchema = external_exports
  .object({
    id: external_exports.string().min(1).max(128),
    resourceType: external_exports.enum(['NODE', 'WORKSPACE', 'MODEL', 'IMAGE_MODEL', 'TEMPLATE']),
    nodeId: external_exports.string().min(1).max(128).optional(),
    workspaceId: external_exports.string().min(1).max(128).optional(),
    modelId: external_exports.string().min(1).max(128).optional(),
    imageModelId: external_exports.string().min(1).max(128).optional(),
    templateId: external_exports.string().min(1).max(128).optional(),
    targetType: external_exports.enum(['USER', 'ORGANIZATION']),
    targetUserId: external_exports.number().int().positive().optional(),
    targetOrganizationId: external_exports.number().int().positive().optional(),
    grantScopeOrganizationId: external_exports.number().int().positive(),
    createdByUserId: external_exports.number().int().positive(),
    createdAt: external_exports.number().int().nonnegative()
  })
  .strict()
  .superRefine((grant2, context) => {
    const validResource =
      (grant2.resourceType === 'NODE' &&
        grant2.nodeId !== void 0 &&
        grant2.workspaceId === void 0 &&
        grant2.modelId === void 0 &&
        grant2.imageModelId === void 0 &&
        grant2.templateId === void 0) ||
      (grant2.resourceType === 'WORKSPACE' &&
        grant2.nodeId !== void 0 &&
        grant2.workspaceId !== void 0 &&
        grant2.modelId === void 0 &&
        grant2.imageModelId === void 0 &&
        grant2.templateId === void 0) ||
      (grant2.resourceType === 'MODEL' &&
        grant2.nodeId === void 0 &&
        grant2.workspaceId === void 0 &&
        grant2.modelId !== void 0 &&
        grant2.imageModelId === void 0 &&
        grant2.templateId === void 0) ||
      (grant2.resourceType === 'IMAGE_MODEL' &&
        grant2.nodeId === void 0 &&
        grant2.workspaceId === void 0 &&
        grant2.modelId === void 0 &&
        grant2.imageModelId !== void 0 &&
        grant2.templateId === void 0) ||
      (grant2.resourceType === 'TEMPLATE' &&
        grant2.nodeId === void 0 &&
        grant2.workspaceId === void 0 &&
        grant2.modelId === void 0 &&
        grant2.imageModelId === void 0 &&
        grant2.templateId !== void 0);
    if (!validResource) {
      context.addIssue({ code: 'custom', message: 'resource identifiers must match resourceType' });
    }
    if ((grant2.targetType === 'USER') !== (grant2.targetUserId !== void 0)) {
      context.addIssue({ code: 'custom', message: 'targetUserId must match targetType' });
    }
    if ((grant2.targetType === 'ORGANIZATION') !== (grant2.targetOrganizationId !== void 0)) {
      context.addIssue({ code: 'custom', message: 'targetOrganizationId must match targetType' });
    }
  });
var jsonPointerSchema = external_exports.string().regex(/^(?:|(?:\/(?:[^~/]|~[01])*)+)$/);
var requiredJsonPointerSchema = jsonPointerSchema.min(1);
var oauthProviderInputSchema = external_exports
  .object({
    providerKey: external_exports.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
    name: external_exports.string().trim().min(1).max(128),
    clientId: external_exports.string().min(1).max(512),
    clientSecret: external_exports.string().min(1).max(4096).optional(),
    authorizationEndpoint: external_exports.string().url(),
    tokenEndpoint: external_exports.string().url(),
    userinfoEndpoint: external_exports.string().url(),
    scopes: external_exports.array(external_exports.string().min(1).max(128)).max(32),
    pkceMode: external_exports.enum(['REQUIRED', 'SUPPORTED', 'DISABLED']),
    tokenAuthMethod: external_exports.enum([
      'client_secret_basic',
      'client_secret_post',
      'client_secret_json'
    ]),
    autoProvisioningEnabled: external_exports.boolean().default(false),
    mappings: external_exports
      .object({
        externalUserId: requiredJsonPointerSchema,
        email: jsonPointerSchema.optional(),
        displayName: jsonPointerSchema.optional()
      })
      .strict()
  })
  .strict();
var auditConversationInputModeSchema = external_exports.enum([
  'NEW_SESSION',
  'SEND',
  'CONTINUE',
  'STEER',
  'QUEUE',
  'REPLACE_CURRENT',
  'RUN_NOW',
  'USER_INPUT_RESPONSE',
  'EDIT_QUEUE',
  'DELETE_QUEUE',
  'REORDER_QUEUE',
  'EXECUTE_QUEUE',
  'PAUSE_QUEUE',
  'RESUME_QUEUE'
]);
var auditEventSchema = external_exports
  .object({
    id: external_exports.string().min(1).max(128),
    eventType: external_exports.string().regex(/^[a-z0-9_.-]{1,80}$/),
    occurredAt: external_exports.number().int().nonnegative(),
    result: external_exports.enum(['SUCCESS', 'DENIED', 'FAILED']),
    errorCode: external_exports.string().max(80).nullable().optional(),
    actorUserId: external_exports.number().int().positive().nullable().optional(),
    actorUsername: external_exports.string().max(128).nullable().optional(),
    authenticationMethod: external_exports.enum(['PASSWORD', 'OAUTH2', 'SYSTEM']),
    providerId: external_exports.string().max(128).nullable().optional(),
    requestId: external_exports.string().max(128).nullable().optional(),
    operationId: external_exports.string().max(128).nullable().optional(),
    sessionPublicId: external_exports.string().max(128).nullable().optional(),
    targetType: external_exports.string().max(80).nullable().optional(),
    targetId: external_exports.string().max(128).nullable().optional(),
    targetName: external_exports.string().max(256).nullable().optional(),
    organizationId: external_exports.number().int().positive().nullable().optional(),
    nodeId: external_exports.string().max(128).nullable().optional(),
    workspaceId: external_exports.string().max(128).nullable().optional(),
    agentSessionId: external_exports.string().max(128).nullable().optional(),
    runId: external_exports.string().max(128).nullable().optional(),
    clientMessageId: external_exports.string().max(128).nullable().optional(),
    queueItemId: external_exports.string().max(128).nullable().optional(),
    inputMode: auditConversationInputModeSchema.nullable().optional(),
    hasConversationPayload: external_exports.boolean().optional(),
    metadata: external_exports
      .record(
        external_exports.string(),
        external_exports.union([
          external_exports.string(),
          external_exports.number(),
          external_exports.boolean(),
          external_exports.null()
        ])
      )
      .optional()
  })
  .strict();
var auditConversationReceiptSchema = external_exports
  .object({
    sessionId: external_exports.string().min(1).max(128),
    conversationTitle: external_exports.string().min(1).max(256).optional(),
    runId: external_exports.string().min(1).max(128).optional(),
    queueItemId: external_exports.string().min(1).max(128).optional(),
    inputMode: auditConversationInputModeSchema
  })
  .strict();
var auditConversationPayloadSchema = external_exports
  .object({
    conversationId: external_exports.string().min(1).max(128).optional(),
    conversationTitle: external_exports.string().min(1).max(256),
    userMessage: external_exports.string().min(1).max(2e4),
    queueItemId: external_exports.string().min(1).max(128).optional()
  })
  .strict();
var auditEventDetailSchema = auditEventSchema
  .extend({
    conversationPayload: auditConversationPayloadSchema.optional()
  })
  .strict();

// packages/protocol/dist/direct-transfer.js
var identifierSchema = external_exports
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
var resourceIdentifierSchema = external_exports.string().trim().min(1).max(512);
var relativePathSchema = external_exports.string().min(1).max(4096);
var safeIntegerSchema = external_exports.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
var timestampSchema = external_exports.number().int().positive();
var fingerprintSchema = external_exports
  .string()
  .regex(/^sha-256(?: [A-F0-9]{2}(?::[A-F0-9]{2}){31})$/u);
var sdpSchema = external_exports
  .string()
  .min(1)
  .max(64 * 1024);
var candidateSchema = external_exports.string().min(1).max(4096);
var workspaceDirectTransferCapabilitySchema = external_exports
  .object({
    apiVersion: external_exports.union([external_exports.literal(2), external_exports.literal(3)]),
    transport: external_exports.boolean(),
    upload: external_exports.boolean(),
    download: external_exports.boolean(),
    range: external_exports.boolean(),
    gitCommitBlob: external_exports.boolean(),
    maxChunkBytes: external_exports
      .number()
      .int()
      .min(16 * 1024)
      .max(1024 * 1024)
  })
  .strict();
var directTransferPurposeSchema = external_exports.enum(['TRANSPORT', 'TRANSFER']);
var directTransferDirectionSchema = external_exports.enum(['UPLOAD', 'DOWNLOAD']);
var workspaceFileResourceSchema = external_exports
  .object({
    kind: external_exports.literal('WORKSPACE_FILE'),
    workspaceId: resourceIdentifierSchema,
    path: relativePathSchema,
    repositoryPath: external_exports.string().max(4096).optional(),
    worktreePath: relativePathSchema.optional()
  })
  .strict();
var gitCommitBlobResourceSchema = external_exports
  .object({
    kind: external_exports.literal('GIT_COMMIT_BLOB'),
    workspaceId: resourceIdentifierSchema,
    commit: external_exports.string().min(1).max(256),
    path: relativePathSchema,
    repositoryPath: external_exports.string().max(4096).optional(),
    worktreePath: external_exports.string().max(4096).optional()
  })
  .strict();
var directTransferResourceSchema = external_exports.discriminatedUnion('kind', [
  workspaceFileResourceSchema,
  gitCommitBlobResourceSchema
]);
var directTransferDescriptorBaseSchema = external_exports
  .object({
    resource: directTransferResourceSchema,
    fileName: external_exports.string().trim().min(1).max(512),
    size: safeIntegerSchema
  })
  .strict();
var directUploadDescriptorSchema = directTransferDescriptorBaseSchema
  .extend({
    direction: external_exports.literal('UPLOAD'),
    sha256: external_exports.string().regex(/^[a-f0-9]{64}$/u),
    overwrite: external_exports.boolean().optional(),
    resumeOffset: safeIntegerSchema.optional(),
    composerAttachment: external_exports
      .object({
        id: identifierSchema,
        mime: external_exports.string().trim().min(1).max(256)
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (
      descriptor.resource.kind === 'WORKSPACE_FILE' &&
      (descriptor.resource.repositoryPath !== void 0 || descriptor.resource.worktreePath !== void 0)
    )
      context.addIssue({
        code: 'custom',
        path: ['resource'],
        message: 'Git file targets are read-only'
      });
    if (descriptor.resumeOffset !== void 0 && descriptor.resumeOffset > descriptor.size)
      context.addIssue({
        code: 'custom',
        path: ['resumeOffset'],
        message: 'resume offset cannot exceed the file size'
      });
    if (descriptor.composerAttachment !== void 0 && descriptor.resource.kind !== 'WORKSPACE_FILE')
      context.addIssue({
        code: 'custom',
        path: ['composerAttachment'],
        message: 'composer attachments are supported only for Workspace uploads'
      });
  });
var directDownloadDescriptorSchema = directTransferDescriptorBaseSchema
  .extend({
    direction: external_exports.literal('DOWNLOAD'),
    revision: external_exports.string().trim().min(1).max(512),
    range: external_exports
      .object({
        offset: safeIntegerSchema,
        length: safeIntegerSchema
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (
      descriptor.range !== void 0 &&
      (descriptor.range.length === 0 ||
        descriptor.range.offset + descriptor.range.length > descriptor.size)
    )
      context.addIssue({
        code: 'custom',
        path: ['range'],
        message: 'download range must be non-empty and fit within the file size'
      });
  });
var directTransferDescriptorSchema = external_exports.union([
  directUploadDescriptorSchema,
  directDownloadDescriptorSchema
]);
var directPrepareBaseSchema = external_exports
  .object({
    type: external_exports.literal('direct.prepare'),
    requestId: identifierSchema,
    nodeId: resourceIdentifierSchema,
    nodeGeneration: identifierSchema
  })
  .strict();
var directPrepareRequestSchema = external_exports.discriminatedUnion('purpose', [
  directPrepareBaseSchema.extend({ purpose: external_exports.literal('TRANSPORT') }).strict(),
  directPrepareBaseSchema
    .extend({
      purpose: external_exports.literal('TRANSFER'),
      transportSessionId: identifierSchema,
      transfer: directTransferDescriptorSchema
    })
    .strict()
]);
var directIceCandidateSchema = external_exports
  .object({
    candidate: candidateSchema,
    sdpMid: external_exports.string().max(256).nullable(),
    sdpMLineIndex: external_exports.number().int().min(0).max(1024).nullable()
  })
  .strict();
var directSignalSchema = external_exports.discriminatedUnion('kind', [
  external_exports
    .object({
      kind: external_exports.literal('OFFER'),
      sdp: sdpSchema,
      fingerprint: fingerprintSchema
    })
    .strict(),
  external_exports
    .object({
      kind: external_exports.literal('ANSWER'),
      sdp: sdpSchema,
      fingerprint: fingerprintSchema
    })
    .strict(),
  external_exports
    .object({ kind: external_exports.literal('CANDIDATE'), candidate: directIceCandidateSchema })
    .strict(),
  external_exports.object({ kind: external_exports.literal('END_OF_CANDIDATES') }).strict()
]);
var directSessionIdentitySchema = external_exports
  .object({
    directSessionId: identifierSchema
  })
  .strict();
var directBrowserMessageSchema = external_exports.union([
  directPrepareRequestSchema,
  directSessionIdentitySchema
    .extend({ type: external_exports.literal('direct.signal'), signal: directSignalSchema })
    .strict(),
  directSessionIdentitySchema
    .extend({ type: external_exports.literal('direct.connected') })
    .strict(),
  directSessionIdentitySchema
    .extend({ type: external_exports.literal('direct.heartbeat') })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: external_exports.literal('direct.complete'),
      size: safeIntegerSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: external_exports.literal('direct.cancel'),
      reason: external_exports.string().trim().min(1).max(128).optional()
    })
    .strict()
]);
var directServerMessageSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('direct.prepared'),
      requestId: identifierSchema,
      directSessionId: identifierSchema,
      nodeId: resourceIdentifierSchema,
      nodeGeneration: identifierSchema,
      purpose: directTransferPurposeSchema,
      expiresAt: timestampSchema,
      transportSessionId: identifierSchema.optional(),
      resumeOffset: safeIntegerSchema.optional()
    })
    .strict(),
  directSessionIdentitySchema
    .extend({ type: external_exports.literal('direct.signal'), signal: directSignalSchema })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: external_exports.literal('direct.grant'),
      grant: external_exports.string().min(32).max(4096),
      openExpiresAt: timestampSchema,
      expiresAt: timestampSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: external_exports.literal('direct.heartbeat'),
      alive: external_exports.literal(true),
      expiresAt: timestampSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: external_exports.literal('direct.opened'),
      offset: safeIntegerSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: external_exports.literal('direct.complete'),
      size: safeIntegerSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: external_exports.literal('direct.closed'),
      code: external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('direct.error'),
      requestId: identifierSchema.optional(),
      directSessionId: identifierSchema.optional(),
      code: external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
      message: external_exports.string().trim().min(1).max(1e3)
    })
    .strict()
]);
var directNodeCommandSchema = external_exports.union([
  external_exports
    .object({
      type: external_exports.literal('direct.prepare'),
      directSessionId: identifierSchema,
      workbenchConnectionId: identifierSchema,
      nodeGeneration: identifierSchema,
      purpose: external_exports.literal('TRANSPORT'),
      expiresAt: timestampSchema,
      userAuthorization: external_exports.unknown()
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('direct.prepare'),
      directSessionId: identifierSchema,
      transportSessionId: identifierSchema,
      workbenchConnectionId: identifierSchema,
      nodeGeneration: identifierSchema,
      purpose: external_exports.literal('TRANSFER'),
      expiresAt: timestampSchema,
      transfer: directTransferDescriptorSchema,
      userAuthorization: external_exports.unknown()
    })
    .strict(),
  directSessionIdentitySchema
    .extend({ type: external_exports.literal('direct.signal'), signal: directSignalSchema })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: external_exports.literal('direct.grant'),
      transportSessionId: identifierSchema,
      grant: external_exports.string().min(32).max(4096),
      browserFingerprint: fingerprintSchema,
      nodeFingerprint: fingerprintSchema,
      openExpiresAt: timestampSchema,
      expiresAt: timestampSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({ type: external_exports.literal('direct.heartbeat'), expiresAt: timestampSchema })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: external_exports.literal('direct.cancel'),
      code: external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
    })
    .strict()
]);
var directNodeEventSchema = external_exports.discriminatedUnion('type', [
  directSessionIdentitySchema
    .extend({ type: external_exports.literal('direct.signal'), signal: directSignalSchema })
    .strict(),
  directSessionIdentitySchema
    .extend({ type: external_exports.literal('direct.connected') })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: external_exports.literal('direct.opened'),
      offset: safeIntegerSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: external_exports.literal('direct.complete'),
      size: safeIntegerSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: external_exports.literal('direct.error'),
      code: external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
      message: external_exports.string().trim().min(1).max(1e3)
    })
    .strict()
]);
var directDataOpenFrameSchema = external_exports
  .object({
    type: external_exports.literal('OPEN'),
    directSessionId: identifierSchema,
    grant: external_exports.string().min(32).max(4096)
  })
  .strict();
var directDataAckFrameSchema = external_exports
  .object({
    type: external_exports.literal('ACK'),
    offset: safeIntegerSchema
  })
  .strict();
var directDataCompleteFrameSchema = external_exports
  .object({
    type: external_exports.literal('COMPLETE'),
    size: safeIntegerSchema
  })
  .strict();
var directDataErrorFrameSchema = external_exports
  .object({
    type: external_exports.literal('ERROR'),
    code: external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
  })
  .strict();
var directDataControlFrameSchema = external_exports.discriminatedUnion('type', [
  directDataOpenFrameSchema,
  directDataAckFrameSchema,
  directDataCompleteFrameSchema,
  directDataErrorFrameSchema
]);

// packages/protocol/dist/terminal-direct.js
var id = external_exports
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
var resourceId = external_exports.string().min(1).max(512);
var expiresAt = external_exports.number().int().positive();
var code = external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
var fingerprint = external_exports.string().regex(/^sha-256(?: [A-F0-9]{2}(?::[A-F0-9]{2}){31})$/u);
var terminalDirectCapabilitySchema = external_exports
  .object({ apiVersion: external_exports.literal(1), transport: external_exports.literal(true) })
  .strict();
var terminalDirectBrowserMessageSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('terminal.direct.prepare'),
      requestId: id,
      nodeId: resourceId,
      nodeGeneration: id,
      transportSessionId: id,
      terminalId: resourceId,
      workspaceId: resourceId.optional(),
      afterSequence: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      readonly: external_exports.boolean(),
      takeover: external_exports.literal(false).optional()
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('terminal.direct.heartbeat'), directSessionId: id })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('terminal.direct.cancel'), directSessionId: id })
    .strict()
]);
var terminalDirectServerMessageSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('terminal.direct.prepared'),
      requestId: id,
      directSessionId: id,
      grant: external_exports.string().min(32).max(4096),
      openExpiresAt: expiresAt,
      expiresAt
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('terminal.direct.heartbeat'),
      directSessionId: id,
      expiresAt
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('terminal.direct.closed'), directSessionId: id, code })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('terminal.direct.error'),
      requestId: id.optional(),
      directSessionId: id.optional(),
      code,
      message: external_exports.string().min(1).max(1e3)
    })
    .strict()
]);
var terminalDirectNodeCommandSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('terminal.direct.prepare'),
      directSessionId: id,
      transportSessionId: id,
      workbenchConnectionId: id,
      nodeGeneration: id,
      terminalId: resourceId,
      workspaceId: resourceId.optional(),
      afterSequence: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      readonly: external_exports.boolean(),
      takeover: external_exports.literal(false).optional(),
      grant: external_exports.string().min(32).max(4096),
      browserFingerprint: fingerprint,
      nodeFingerprint: fingerprint,
      openExpiresAt: expiresAt,
      expiresAt
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('terminal.direct.heartbeat'),
      directSessionId: id,
      expiresAt
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('terminal.direct.cancel'), directSessionId: id, code })
    .strict()
]);
var terminalDirectNodeEventSchema = external_exports
  .object({
    type: external_exports.literal('terminal.direct.ready'),
    directSessionId: id,
    phase: external_exports.enum(['PREPARED', 'ATTACHED']).optional()
  })
  .strict();
var terminalDirectOpenFrameSchema = external_exports
  .object({
    type: external_exports.literal('OPEN'),
    directSessionId: id,
    grant: external_exports.string().min(32).max(4096)
  })
  .strict();
var terminalDirectAttachedFrameSchema = external_exports
  .object({
    type: external_exports.literal('ATTACHED'),
    terminalId: resourceId,
    afterSequence: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict();

// packages/protocol/dist/remote-desktop.js
var id2 = external_exports
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
var nodeId = external_exports.string().min(1).max(512);
var revision = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var timestamp = external_exports.number().int().positive().max(Number.MAX_SAFE_INTEGER);
var code2 = external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
var grant = external_exports.string().min(32).max(4096);
var fingerprint2 = external_exports
  .string()
  .regex(/^sha-256(?: [A-F0-9]{2}(?::[A-F0-9]{2}){31})$/u);
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
    desktopGeneration: id2,
    topologyRevision: revision,
    framebuffer: external_exports.object({ width: dimension, height: dimension }).strict(),
    displays: external_exports
      .array(
        external_exports
          .object({
            displayId: id2,
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
      nodeGeneration: id2,
      reasonCode: code2
    })
    .strict(),
  external_exports
    .object({
      apiVersion: external_exports.literal(1),
      available: external_exports.literal(true),
      nodeGeneration: id2,
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
      requestId: id2,
      nodeId,
      nodeGeneration: id2,
      transportSessionId: id2,
      desktopGeneration: id2,
      topologyRevision: revision,
      mode: remoteDesktopModeSchema
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.direct.heartbeat'), attachmentId: id2 })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.direct.cancel'), attachmentId: id2 })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.ready'), attachmentId: id2 })
    .strict()
]);
var remoteDesktopDirectServerMessageSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.prepared'),
      requestId: id2,
      attachmentId: id2,
      grant,
      openExpiresAt: timestamp,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.heartbeat'),
      attachmentId: id2,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.closed'),
      attachmentId: id2,
      code: code2
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.settled'),
      attachmentId: id2,
      code: code2
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.error'),
      requestId: id2.optional(),
      attachmentId: id2.optional(),
      settled: external_exports.literal(true).optional(),
      code: code2,
      message: external_exports.string().min(1).max(1e3)
    })
    .strict()
]);
var remoteDesktopDirectNodeCommandSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.prepare'),
      attachmentId: id2,
      transportSessionId: id2,
      workbenchConnectionId: id2,
      nodeGeneration: id2,
      desktopGeneration: id2,
      topologyRevision: revision,
      mode: remoteDesktopModeSchema,
      grant,
      browserFingerprint: fingerprint2,
      nodeFingerprint: fingerprint2,
      openExpiresAt: timestamp,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.heartbeat'),
      attachmentId: id2,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.cancel'),
      attachmentId: id2,
      code: code2
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.ready'), attachmentId: id2 })
    .strict()
]);
var remoteDesktopDirectNodeEventSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.ready'),
      attachmentId: id2,
      nodeGeneration: id2,
      phase: external_exports.enum(['PREPARED', 'OPEN', 'ATTACHED', 'ACTIVE'])
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.direct.closed'),
      attachmentId: id2,
      nodeGeneration: id2,
      code: code2
    })
    .strict()
]);
var remoteDesktopRelayBrowserMessageSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.prepare'),
      requestId: id2,
      nodeId,
      nodeGeneration: id2,
      desktopGeneration: id2,
      topologyRevision: revision,
      mode: remoteDesktopModeSchema
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.relay.heartbeat'), attachmentId: id2 })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.relay.cancel'), attachmentId: id2 })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.ready'), attachmentId: id2 })
    .strict()
]);
var remoteDesktopRelayServerMessageSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.prepared'),
      requestId: id2,
      attachmentId: id2,
      grant,
      ticket: grant,
      openExpiresAt: timestamp,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.heartbeat'),
      attachmentId: id2,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.closed'),
      attachmentId: id2,
      code: code2
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.settled'),
      attachmentId: id2,
      code: code2
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.error'),
      requestId: id2.optional(),
      attachmentId: id2.optional(),
      settled: external_exports.literal(true).optional(),
      code: code2,
      message: external_exports.string().min(1).max(1e3)
    })
    .strict()
]);
var remoteDesktopRelayNodeCommandSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.prepare'),
      attachmentId: id2,
      workbenchConnectionId: id2,
      nodeGeneration: id2,
      desktopGeneration: id2,
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
      attachmentId: id2,
      expiresAt: timestamp
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.cancel'),
      attachmentId: id2,
      code: code2
    })
    .strict(),
  external_exports
    .object({ type: external_exports.literal('desktop.ready'), attachmentId: id2 })
    .strict()
]);
var remoteDesktopRelayNodeEventSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.ready'),
      attachmentId: id2,
      nodeGeneration: id2,
      phase: external_exports.enum(['PREPARED', 'OPEN', 'ATTACHED', 'ACTIVE'])
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('desktop.relay.closed'),
      attachmentId: id2,
      nodeGeneration: id2,
      code: code2
    })
    .strict()
]);
var remoteDesktopRelayBrowserAttachSchema = external_exports
  .object({
    type: external_exports.literal('desktop.relay.browser'),
    attachmentId: id2,
    workbenchConnectionId: id2,
    ticket: grant
  })
  .strict();
var remoteDesktopRelayNodeAttachSchema = external_exports
  .object({
    type: external_exports.literal('desktop.relay.node'),
    nodeId,
    nodeGeneration: id2,
    attachmentId: id2,
    ticket: grant,
    credential: external_exports.string().min(1).max(4096)
  })
  .strict();
var remoteDesktopDirectOpenFrameSchema = external_exports
  .object({
    type: external_exports.literal('OPEN'),
    attachmentId: id2,
    grant
  })
  .strict();
var remoteDesktopAttachedFrameSchema = external_exports
  .object({
    type: external_exports.literal('ATTACHED'),
    attachmentId: id2
  })
  .strict();

// packages/protocol/dist/chatgpt-oauth.js
var CHATGPT_ISSUER = 'https://auth.openai.com';
var CHATGPT_TOKEN_ENDPOINT = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
var CHATGPT_JWKS_ENDPOINT = `${CHATGPT_ISSUER}/.well-known/jwks.json`;
var CHATGPT_REVOKE_ENDPOINT = `${CHATGPT_ISSUER}/api/accounts/oauth/revoke`;
var identifier2 = external_exports.string().min(1).max(512);
var chatgptTokenResponseSchema = external_exports
  .object({
    access_token: external_exports.string().min(1).max(131072),
    refresh_token: external_exports.string().min(1).max(131072).optional(),
    id_token: external_exports.string().min(1).max(131072).optional(),
    token_type: external_exports.literal('Bearer'),
    expires_in: external_exports.number().int().positive().max(86400),
    scope: external_exports.string().max(8192),
    earliest_refresh_at: external_exports.number().int().nonnegative().optional()
  })
  .strip();
var chatgptLoginStartSchema = external_exports
  .object({
    attemptId: identifier2,
    nonce: external_exports.string().min(32).max(256),
    clientId: identifier2.optional(),
    subject: identifier2.optional(),
    socks5Url: external_exports.string().url().max(2048).optional()
  })
  .strict();
var chatgptLoginResultSchema = external_exports
  .object({
    attemptId: identifier2,
    clientId: identifier2,
    hostId: identifier2,
    tokens: chatgptTokenResponseSchema
  })
  .strict();
var chatgptNodeLoginStatusSchema = external_exports.discriminatedUnion('status', [
  external_exports
    .object({
      status: external_exports.literal('PENDING'),
      verificationUri: external_exports.string().url().max(2048),
      expiresAt: external_exports.number().int().nonnegative()
    })
    .strict(),
  external_exports
    .object({ status: external_exports.literal('SUCCEEDED'), result: chatgptLoginResultSchema })
    .strict(),
  external_exports
    .object({
      status: external_exports.literal('FAILED'),
      code: external_exports.string().regex(/^CHATGPT_[A-Z0-9_]{1,64}$/u)
    })
    .strict()
]);
var chatgptLoginCapabilitySchema = external_exports
  .object({
    apiVersion: external_exports.literal(1),
    loopback: external_exports.literal(true)
  })
  .strict();

// packages/protocol/dist/composer-tags.js
var path = external_exports.string().min(1).max(4096);
var name = external_exports.string().min(1).max(512);
var MAX_COMPOSER_TAG_BYTES = 128 * 1024;
var MAX_COMPOSER_QUOTE_CHARACTERS = 8e3;
var quoteFields = {
  type: external_exports.literal('quote'),
  id: external_exports.string().min(1).max(128),
  label: name,
  text: external_exports
    .string()
    .min(1)
    .max(MAX_COMPOSER_QUOTE_CHARACTERS)
    .refine((value) => value.trim().length > 0)
};
var quoteLine = external_exports.number().int().positive().max(Number.MAX_SAFE_INTEGER);
var composerQuoteSchema = external_exports
  .discriminatedUnion('source', [
    external_exports
      .object({
        ...quoteFields,
        source: external_exports.literal('file'),
        path,
        origin: external_exports.enum(['WORKING_TREE', 'HISTORY']),
        startLine: quoteLine,
        endLine: quoteLine,
        revision: name.optional(),
        unsaved: external_exports.boolean().optional()
      })
      .strict(),
    external_exports
      .object({
        ...quoteFields,
        source: external_exports.literal('diff'),
        path,
        origin: external_exports.enum(['WORKING_TREE', 'HISTORY', 'TOOL_CHANGE']),
        revision: name.optional(),
        side: external_exports.enum(['old', 'new', 'mixed']).optional(),
        startLine: quoteLine.optional(),
        endLine: quoteLine.optional(),
        oldStartLine: quoteLine.optional(),
        oldEndLine: quoteLine.optional()
      })
      .strict(),
    external_exports
      .object({
        ...quoteFields,
        source: external_exports.literal('assistant'),
        messageId: external_exports.string().min(1).max(512),
        timestamp: name.optional(),
        streaming: external_exports.boolean().optional()
      })
      .strict()
  ])
  .refine((quote) => {
    if (quote.source === 'assistant') return true;
    if ((quote.startLine === void 0) !== (quote.endLine === void 0)) return false;
    if (quote.startLine !== void 0 && quote.endLine < quote.startLine) return false;
    return (
      quote.source !== 'diff' ||
      ((quote.oldStartLine === void 0) === (quote.oldEndLine === void 0) &&
        (quote.oldStartLine === void 0 || quote.oldEndLine >= quote.oldStartLine))
    );
  });
var channelDisplayNameSchema = external_exports
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) =>
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  );
var channelOriginSchema = external_exports
  .object({
    source: external_exports.literal('WEB_SHARE'),
    channelId: external_exports.string().min(1).max(128),
    senderId: external_exports.string().min(1).max(128),
    name: channelDisplayNameSchema
  })
  .strict();
var sessionMessageOriginSchema = external_exports
  .object({
    sessionId: external_exports.string().min(1).max(512).optional(),
    name: name.optional(),
    relation: external_exports.enum(['parent', 'child', 'descendant', 'other']).optional()
  })
  .strict()
  .refine((value) => (value.sessionId === void 0) === (value.name === void 0))
  .refine((value) => value.relation === void 0 || value.sessionId !== void 0);
var relativePath = path.refine((value) => !/^(?:[\\/]|[A-Za-z]:)/u.test(value));
var workspacePath = relativePath.refine((value) => !value.split(/[\\/]/u).includes('..'));
function isComposerAttachmentResourcePath(value) {
  return (
    /^mar-attachment:\/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/[^/\\\0]+$/u.test(
      value
    ) && !value.split('/').includes('..')
  );
}
var attachment = external_exports
  .object({
    name,
    mime: external_exports.string().min(1).max(128),
    path,
    workspacePath: workspacePath.optional()
  })
  .strict()
  .refine((value) => {
    const target = value.workspacePath ?? value.path;
    return (
      isComposerAttachmentResourcePath(target) ||
      (relativePath.safeParse(value.path).success &&
        workspacePath.safeParse(target).success &&
        target.startsWith('.mar/temp-files/'))
    );
  });
var composerTagSchemas = {
  mar_steer: external_exports.object({ message: external_exports.string().max(1e5) }).strict(),
  mar_channel: channelOriginSchema,
  mar_session_origin: sessionMessageOriginSchema,
  mar_goal_start: external_exports
    .object({
      objective: external_exports.string().max(1e5),
      instruction: external_exports.string().max(1e5).optional()
    })
    .strict(),
  mar_goal_continue: external_exports
    .object({
      objective: external_exports.string().max(1e5).optional(),
      instruction: external_exports.string().max(1e5).optional()
    })
    .strict(),
  mar_restart: external_exports.object({}).strict(),
  mar_attachments: external_exports
    .object({
      files: external_exports.array(attachment).min(1).max(5),
      instruction: external_exports.string().min(1).max(512).optional()
    })
    .strict(),
  mar_schedule: external_exports
    .object({ objective: external_exports.string().min(1).max(1e5) })
    .strict(),
  mar_skills: external_exports
    .object({
      action: external_exports.literal('use'),
      instruction: external_exports.string().min(1).max(512),
      skills: external_exports
        .array(
          external_exports
            .object({ name, source: external_exports.enum(['NODE_HOME', 'WORKSPACE']), path })
            .strict()
        )
        .min(1)
        .max(128)
    })
    .strict(),
  mar_references: external_exports
    .object({
      references: external_exports
        .array(
          external_exports.union([
            external_exports
              .object({
                type: external_exports.enum(['file', 'directory']),
                path: workspacePath,
                label: name,
                runnerPath: relativePath.optional()
              })
              .strict(),
            external_exports
              .object({
                type: external_exports.literal('session'),
                sessionId: external_exports.string().min(1).max(512),
                label: name
              })
              .strict(),
            composerQuoteSchema
          ])
        )
        .min(1)
        .max(128)
    })
    .strict()
};

// packages/protocol/dist/session-shares.js
var id3 = external_exports.string().min(1).max(128);
var timestamp2 = external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var sessionShareTargetSchema = external_exports
  .object({ nodeId: id3, workspaceId: id3, sessionId: id3 })
  .strict();
var sessionShareSchema = sessionShareTargetSchema
  .extend({
    id: id3,
    createdAt: timestamp2,
    expiresAt: timestamp2.nullable()
  })
  .strip();
var sessionShareCreateInputSchema = external_exports
  .object({
    nodeId: id3,
    workspaceId: id3,
    expiresAt: external_exports.string().datetime().nullable().default(null)
  })
  .strict();
var sessionSharePasswordSchema = external_exports.string().regex(/^[0-9]{6}$/u);
var sessionShareCredentialSchema = external_exports.string().regex(/^[A-Za-z0-9_-]{43}$/u);
var sessionShareAuthInputSchema = external_exports.union([
  external_exports.object({ password: sessionSharePasswordSchema }).strict(),
  external_exports.object({ credential: sessionShareCredentialSchema }).strict()
]);
var sessionShareAuthResultSchema = external_exports.object({
  share: sessionShareSchema,
  credential: sessionShareCredentialSchema,
  sharerName: external_exports.string().min(1).max(512),
  workspaceName: external_exports.string().min(1).max(255).optional()
});
var sessionShareVisitorSchema = external_exports
  .object({ visitorId: id3, name: channelDisplayNameSchema.optional() })
  .strict();

// packages/protocol/dist/skill.js
var skillScopeSchema = external_exports.enum(['ENTERPRISE', 'ORGANIZATION', 'PERSONAL']);
var configurableSkillScopeSchema = external_exports.enum(['ORGANIZATION', 'PERSONAL']);
var skillSourceKindSchema = external_exports.enum(['SKILLS_SH', 'REPOSITORY']);
var httpsLocatorSchema = external_exports
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'locator must be an HTTPS URL without userinfo');
var sshGitLocatorSchema = external_exports
  .string()
  .min(1)
  .max(2048)
  .regex(
    /^git@[A-Za-z0-9.-]+:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.git)?$/u,
    'locator must be an HTTPS URL or git@ SSH repository'
  );
var skillSourceInputSchema = external_exports
  .object({
    kind: skillSourceKindSchema,
    scope: configurableSkillScopeSchema,
    organizationId: external_exports.number().int().positive().optional(),
    name: external_exports.string().trim().min(1).max(128),
    locator: external_exports.union([
      external_exports.literal('skills.sh'),
      httpsLocatorSchema,
      sshGitLocatorSchema
    ]),
    enabled: external_exports.boolean().optional()
  })
  .strict()
  .superRefine((source, context) => {
    if ((source.scope === 'ORGANIZATION') !== (source.organizationId !== void 0))
      context.addIssue({ code: 'custom', message: 'organizationId must match scope' });
    if (source.kind === 'SKILLS_SH' && source.locator !== 'skills.sh')
      context.addIssue({ code: 'custom', message: 'skills.sh source locator is fixed' });
    if (source.kind === 'REPOSITORY' && source.locator === 'skills.sh')
      context.addIssue({
        code: 'custom',
        message: 'repository source requires repository locator'
      });
  });
var skillSourceSchema = external_exports
  .object({
    id: external_exports.string().min(1).max(128),
    kind: skillSourceKindSchema,
    scope: skillScopeSchema,
    organizationId: external_exports.number().int().positive().optional(),
    ownerUserId: external_exports.number().int().positive().optional(),
    name: external_exports.string().trim().min(1).max(128),
    locator: external_exports.union([
      external_exports.literal('skills.sh'),
      httpsLocatorSchema,
      sshGitLocatorSchema
    ]),
    enabled: external_exports.boolean().optional(),
    builtIn: external_exports.boolean(),
    status: external_exports.enum(['READY', 'DEGRADED', 'DISABLED']),
    lastErrorCode: external_exports.string().min(1).max(80).nullable(),
    createdAt: external_exports.number().int().nonnegative(),
    updatedAt: external_exports.number().int().nonnegative()
  })
  .strict();
var skillVersionSummarySchema = external_exports
  .object({
    id: external_exports.string().min(1).max(128),
    commitSha: external_exports.string().regex(/^[0-9a-f]{40}$/),
    contentHash: external_exports.string().regex(/^[0-9a-f]{64}$/),
    createdAt: external_exports.number().int().nonnegative()
  })
  .strict();
var normalizedSkillNameSchema = external_exports
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
var skillTagSchema = external_exports.string().trim().min(1).max(32);
var skillPathSchema = external_exports.union([
  external_exports.literal('.'),
  external_exports
    .string()
    .min(1)
    .max(1024)
    .regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\\0]+$/)
]);
var skillFavoriteSchema = external_exports
  .object({
    id: external_exports.string().min(1).max(128),
    sourceId: external_exports.string().min(1).max(128),
    scope: configurableSkillScopeSchema,
    ownerOrganizationId: external_exports.number().int().positive().optional(),
    ownerUserId: external_exports.number().int().positive().optional(),
    repositoryIdentity: external_exports.string().min(1).max(512),
    skillPath: skillPathSchema,
    normalizedName: normalizedSkillNameSchema,
    featured: external_exports.boolean(),
    tags: external_exports.array(skillTagSchema).max(10),
    currentVersion: skillVersionSummarySchema,
    createdAt: external_exports.number().int().nonnegative(),
    updatedAt: external_exports.number().int().nonnegative()
  })
  .strict()
  .superRefine((favorite, context) => {
    if ((favorite.scope === 'ORGANIZATION') !== (favorite.ownerOrganizationId !== void 0))
      context.addIssue({ code: 'custom', message: 'organization owner must match scope' });
    if ((favorite.scope === 'PERSONAL') !== (favorite.ownerUserId !== void 0))
      context.addIssue({ code: 'custom', message: 'user owner must match scope' });
  });
var skillFavoriteCreateInputSchema = external_exports
  .object({
    sourceId: external_exports.string().min(1).max(128),
    candidateId: external_exports.string().min(1).max(1024),
    skillPath: skillPathSchema.optional(),
    scope: skillScopeSchema,
    organizationId: external_exports.number().int().positive().optional(),
    featured: external_exports.boolean().optional(),
    tags: external_exports.array(skillTagSchema).max(10).optional()
  })
  .strict()
  .superRefine((favorite, context) => {
    if ((favorite.scope === 'ORGANIZATION') !== (favorite.organizationId !== void 0))
      context.addIssue({ code: 'custom', message: 'organizationId must match scope' });
    const tags = favorite.tags ?? [];
    if (new Set(tags.map((tag) => tag.toLocaleLowerCase())).size !== tags.length)
      context.addIssue({ code: 'custom', message: 'tags must be unique' });
  });
var skillFavoritePresentationInputSchema = external_exports
  .object({
    featured: external_exports.boolean(),
    tags: external_exports.array(skillTagSchema).max(10)
  })
  .strict()
  .superRefine((favorite, context) => {
    if (new Set(favorite.tags.map((tag) => tag.toLocaleLowerCase())).size !== favorite.tags.length)
      context.addIssue({ code: 'custom', message: 'tags must be unique' });
  });
var skillInstallMetadataSchema = external_exports
  .object({
    schemaVersion: external_exports.literal(1),
    favoriteId: external_exports.string().min(1).max(128),
    versionId: external_exports.string().min(1).max(128),
    commitSha: external_exports.string().regex(/^[0-9a-f]{40}$/),
    contentHash: external_exports.string().regex(/^[0-9a-f]{64}$/),
    installedAt: external_exports.number().int().nonnegative()
  })
  .strict();
var skillInstallStatusSchema = external_exports.enum([
  'CURRENT',
  'UPDATE_AVAILABLE',
  'UNKNOWN_VERSION',
  'PARTIAL',
  'INVALID',
  'GIT_EXCLUDE_BROKEN',
  'INVALID_LINK'
]);
var skillCompatibilityModeSchema = external_exports.enum([
  'SYMLINK',
  'JUNCTION',
  'MANAGED_COPY',
  'UNAVAILABLE'
]);
var installedSkillSchema = external_exports
  .object({
    name: normalizedSkillNameSchema,
    description: external_exports.string().max(4096),
    status: skillInstallStatusSchema,
    installedCommitSha: external_exports
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable()
      .optional(),
    favoriteCurrentCommitSha: external_exports
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable()
      .optional()
  })
  .strict();
var skillTargetInspectionSchema = external_exports
  .object({
    targetKind: external_exports.enum(['NODE', 'WORKSPACE']),
    compatibilityMode: skillCompatibilityModeSchema,
    skills: external_exports.array(installedSkillSchema).max(1e3)
  })
  .strict();

// packages/protocol/dist/mcp.js
var httpsUrlSchema = external_exports
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'URL must use HTTPS without userinfo');
var mcpNameSchema = external_exports
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/u);
var environmentNameSchema = external_exports.string().regex(/^[A-Z_][A-Z0-9_]*$/u);
var secretReferenceSchema = external_exports.object({ secretName: environmentNameSchema }).strict();
var referenceMapSchema = external_exports
  .record(environmentNameSchema, secretReferenceSchema)
  .default({});
var headerReferenceMapSchema = external_exports
  .record(
    external_exports
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u),
    secretReferenceSchema
  )
  .default({});
var mcpSourceInputSchema = external_exports
  .object({
    scope: configurableSkillScopeSchema,
    organizationId: external_exports.number().int().positive().optional(),
    name: external_exports.string().trim().min(1).max(128),
    locator: httpsUrlSchema,
    enabled: external_exports.boolean().optional()
  })
  .strict()
  .superRefine((source, context) => {
    if ((source.scope === 'ORGANIZATION') !== (source.organizationId !== void 0))
      context.addIssue({ code: 'custom', message: 'organizationId must match scope' });
  });
var mcpRuntimeDescriptorSchema = external_exports.discriminatedUnion('transport', [
  external_exports
    .object({
      transport: external_exports.literal('STDIO'),
      command: external_exports
        .string()
        .trim()
        .min(1)
        .max(512)
        .regex(/^[^\r\n\0]+$/u),
      args: external_exports
        .array(
          external_exports
            .string()
            .max(2048)
            .regex(/^[^\0]*$/u)
        )
        .max(64)
        .default([]),
      environment: referenceMapSchema.optional()
    })
    .strict(),
  external_exports
    .object({
      transport: external_exports.literal('HTTP'),
      url: httpsUrlSchema,
      headers: headerReferenceMapSchema.optional()
    })
    .strict()
]);
var mcpCatalogEntrySchema = external_exports
  .object({
    id: external_exports.string().min(1).max(128),
    sourceId: external_exports.string().min(1).max(128),
    scope: skillScopeSchema,
    ownerOrganizationId: external_exports.number().int().positive().optional(),
    ownerUserId: external_exports.number().int().positive().optional(),
    serverName: mcpNameSchema,
    displayName: external_exports.string().trim().min(1).max(128),
    description: external_exports.string().max(4096),
    version: external_exports
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => value !== 'latest'),
    featured: external_exports.boolean(),
    tags: external_exports.array(external_exports.string().trim().min(1).max(32)).max(10),
    runtime: mcpRuntimeDescriptorSchema,
    createdAt: external_exports.number().int().nonnegative(),
    updatedAt: external_exports.number().int().nonnegative()
  })
  .strict()
  .superRefine((entry, context) => {
    if ((entry.scope === 'ORGANIZATION') !== (entry.ownerOrganizationId !== void 0))
      context.addIssue({ code: 'custom', message: 'organization owner must match scope' });
    if ((entry.scope === 'PERSONAL') !== (entry.ownerUserId !== void 0))
      context.addIssue({ code: 'custom', message: 'user owner must match scope' });
  });
var mcpInstallationConfigurationSchema = external_exports
  .object({
    arguments: external_exports
      .array(
        external_exports
          .string()
          .max(2048)
          .regex(/^[^\0]*$/u)
      )
      .max(32)
      .optional(),
    environment: referenceMapSchema.optional(),
    headers: headerReferenceMapSchema.optional()
  })
  .strict();
var mcpInstallationInputSchema = external_exports
  .object({
    catalogEntryId: external_exports.string().min(1).max(128),
    enabled: external_exports.boolean().default(true),
    configuration: mcpInstallationConfigurationSchema.default({})
  })
  .strict();
var installedMcpSchema = external_exports
  .object({
    catalogEntryId: external_exports.string().min(1).max(128),
    serverName: mcpNameSchema,
    displayName: external_exports.string().trim().min(1).max(128),
    version: external_exports.string().trim().min(1).max(255),
    origin: external_exports.enum(['NODE', 'WORKSPACE']),
    enabled: external_exports.boolean(),
    status: external_exports.enum(['CURRENT', 'UPDATE_AVAILABLE', 'INVALID', 'UNAVAILABLE']),
    installedAt: external_exports.number().int().nonnegative()
  })
  .strict();
var mcpTargetInspectionSchema = external_exports
  .object({
    targetKind: external_exports.enum(['NODE', 'WORKSPACE']),
    installations: external_exports.array(installedMcpSchema).max(500),
    executionBuiltIns: external_exports
      .array(external_exports.enum(['mar_schedule', 'mar_notification']))
      .max(2)
      .optional()
  })
  .strict();

// packages/protocol/dist/mail-notification.js
var id4 = external_exports
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
var mailNotificationRequestSchema = external_exports
  .object({
    executionId: id4,
    sessionId: id4,
    workspaceId: id4,
    userId: external_exports.number().int().positive().safe(),
    source: external_exports.enum(['MANUAL', 'SCHEDULED']),
    callId: external_exports.string().uuid(),
    templateId: external_exports
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9-]*$/u),
    title: external_exports
      .string()
      .max(160)
      .regex(/^[^\r\n]*$/u)
      .optional(),
    recipientEmail: external_exports.string().min(3).max(320).optional(),
    message: external_exports.string().min(1).max(4e3)
  })
  .strict();
var mailNotificationResponseSchema = external_exports.union([
  external_exports.object({ accepted: external_exports.literal(true) }).strict(),
  external_exports
    .object({
      error: external_exports
        .object({
          code: external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
          message: external_exports.string().min(1).max(512)
        })
        .strict()
    })
    .strict()
]);

// packages/protocol/dist/marctl-execution-credential.js
var id5 = external_exports.string().min(1).max(256);
var marctlUserTokenSchema = external_exports
  .string()
  .max(16384)
  .regex(/^marctl_user_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
var token = marctlUserTokenSchema;
var marctlExecutionCredentialRequestSchema = external_exports
  .object({
    parentToken: token,
    workspaceId: id5,
    sessionId: id5,
    executionId: id5,
    userId: external_exports.number().int().positive().safe()
  })
  .strict();
var marctlExecutionCredentialResponseSchema = external_exports.union([
  external_exports.object({ token }).strict(),
  external_exports
    .object({
      error: external_exports
        .object({
          code: external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
          message: external_exports.string().min(1).max(1e3)
        })
        .strict()
    })
    .strict()
]);

// packages/protocol/dist/session-group.js
var sessionGroupSchema = external_exports.enum(['MAIN', 'CHILD']);
var sessionRunningCountsSchema = external_exports.object({
  MAIN: external_exports.number().int().nonnegative().safe(),
  CHILD: external_exports.number().int().nonnegative().safe()
});
var sessionGroupChangedSchema = external_exports
  .object({
    nodeId: external_exports.string().min(1).max(128),
    workspaceId: external_exports.string().min(1).max(128),
    sessionId: external_exports.string().min(1).max(128),
    sessionGroup: external_exports.literal('MAIN')
  })
  .strict();

// packages/protocol/dist/notification-channels.js
var notificationInput = external_exports
  .object({
    channels: external_exports
      .array(external_exports.enum(['push', 'email']))
      .min(1)
      .max(2)
      .default(['push']),
    title: external_exports
      .string()
      .max(160)
      .regex(/^[^\r\n]*$/u)
      .optional(),
    message: external_exports.string().min(1).max(4e3),
    recipientEmail: external_exports.string().email().max(320).optional(),
    templateId: external_exports.enum(['', 'notification-en-US', 'notification-zh-CN']).optional()
  })
  .strict();
function validateChannels(input, context) {
  if (new Set(input.channels).size !== input.channels.length)
    context.addIssue({ code: 'custom', message: 'Duplicate notification channels.' });
  if (
    !input.channels.includes('email') &&
    (input.recipientEmail !== void 0 || input.templateId !== void 0)
  )
    context.addIssue({
      code: 'custom',
      message: 'Email parameters must match the requested channels.'
    });
}
var notificationInputSchema = notificationInput.superRefine(validateChannels);
var notificationChannelsRequestSchema = notificationInput
  .extend({
    ...mailNotificationRequestSchema.pick({
      executionId: true,
      sessionId: true,
      workspaceId: true,
      userId: true,
      source: true,
      callId: true
    }).shape,
    apiVersion: external_exports.literal(1),
    eventType: external_exports.literal('notification'),
    kind: external_exports.literal('AGENT_MESSAGE'),
    occurredAt: external_exports.number().int().nonnegative().safe(),
    sessionTitle: external_exports.string().min(1).max(160),
    sessionGroup: sessionGroupSchema.optional()
  })
  .superRefine(validateChannels);
var count = external_exports.number().int().min(0).max(32);
var pushDeliveryResultSchema = external_exports
  .object({
    status: external_exports.enum([
      'suppressed',
      'skipped',
      'accepted',
      'partial',
      'failed',
      'uncertain'
    ]),
    reason: external_exports
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
      .optional(),
    eligible: count,
    attempted: count,
    accepted: count,
    skipped: count,
    failed: count,
    uncertain: count
  })
  .strict();
var channelError = external_exports
  .object({
    code: external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
    message: external_exports.string().min(1).max(512)
  })
  .strict();
var notificationChannelsResultSchema = external_exports
  .object({
    callId: external_exports.string().uuid(),
    push: external_exports
      .object({
        notificationId: external_exports.string().uuid().optional(),
        persisted: external_exports.boolean(),
        delivery: pushDeliveryResultSchema
      })
      .strict()
      .optional(),
    email: external_exports
      .object({
        status: external_exports.enum(['accepted', 'failed', 'uncertain']),
        error: channelError.optional()
      })
      .strict()
      .optional()
  })
  .strict();
var notificationChannelsResponseSchema = external_exports.union([
  notificationChannelsResultSchema,
  external_exports.object({ error: channelError }).strict()
]);

// packages/protocol/dist/web-push.js
var webPushSubscriptionSchema = external_exports
  .object({
    endpoint: external_exports.string().url().max(2048),
    expirationTime: external_exports.number().int().nonnegative().safe().nullable().optional(),
    keys: external_exports
      .object({
        p256dh: external_exports.string().regex(/^[A-Za-z0-9_-]{87}$/u),
        auth: external_exports.string().regex(/^[A-Za-z0-9_-]{22}$/u)
      })
      .strict()
  })
  .strict();
var webPushRegistrationSchema = external_exports
  .object({
    clientKind: external_exports.literal('mobile'),
    clientToken: external_exports.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    subscription: webPushSubscriptionSchema,
    bindingVersion: external_exports.number().int().positive().safe().optional(),
    enabled: external_exports.boolean().default(true)
  })
  .strict();
var webPushClientRequestSchema = webPushRegistrationSchema.extend({
  expectedAccount: external_exports.string().min(1).max(128)
});
var webPushClientResolveSchema = webPushClientRequestSchema.pick({
  clientToken: true,
  expectedAccount: true
});

// packages/protocol/dist/workbench-notification.js
var identity = external_exports.string().min(1).max(256);
var timestamp3 = external_exports.number().int().nonnegative().safe();
var notificationTargetSchema = external_exports.discriminatedUnion('targetType', [
  external_exports
    .object({
      targetType: external_exports.literal('WORKSPACE_SESSION'),
      nodeId: identity,
      workspaceId: identity,
      sessionId: identity,
      sessionGroup: sessionGroupSchema.optional(),
      sessionName: external_exports.string().optional()
    })
    .strict(),
  external_exports
    .object({
      targetType: external_exports.literal('HOSTED_CONVERSATION'),
      nodeId: identity,
      conversationId: identity,
      conversationName: external_exports.string()
    })
    .strict()
]);
var serverNotificationSchema = external_exports
  .object({
    id: identity,
    kind: external_exports.enum(['run', 'approval', 'plan', 'user-input', 'schedule', 'agent']),
    title: external_exports.string(),
    message: external_exports.string().max(4e3),
    createdAt: timestamp3,
    updatedAt: timestamp3,
    expiresAt: timestamp3,
    read: external_exports.boolean(),
    target: notificationTargetSchema
  })
  .strict();
var notificationCreatedSchema = external_exports
  .object({
    type: external_exports.literal('notification.created'),
    notification: serverNotificationSchema
  })
  .strict();
var NOTIFICATION_TARGET_READ_ID_LIMIT = 250;
var notificationTargetReadSchema = external_exports.discriminatedUnion('type', [
  external_exports
    .object({
      type: external_exports.literal('notification.session-read'),
      nodeId: identity,
      workspaceId: identity,
      sessionId: identity,
      notificationIds: external_exports.array(identity).max(NOTIFICATION_TARGET_READ_ID_LIMIT),
      readAt: timestamp3
    })
    .strict(),
  external_exports
    .object({
      type: external_exports.literal('notification.conversation-read'),
      nodeId: identity,
      conversationId: identity,
      notificationIds: external_exports.array(identity).max(NOTIFICATION_TARGET_READ_ID_LIMIT),
      readAt: timestamp3
    })
    .strict()
]);

// packages/protocol/dist/management-pagination.js
var MANAGEMENT_MAX_LIMIT = 500;
var managementPageMetadataSchema = external_exports.object({
  page: external_exports.number().int().positive().safe(),
  pageSize: external_exports.number().int().min(1).max(MANAGEMENT_MAX_LIMIT),
  total: external_exports.number().int().nonnegative().safe(),
  hasMore: external_exports.boolean()
});

// packages/protocol/dist/index.js
var healthStatusSchema = external_exports.object({
  status: external_exports.literal('ok')
});
var NODE_PROTOCOL_VERSION = 3;
var WORKBENCH_PROTOCOL_VERSION = 1;
var nodePlatformSchema = external_exports.enum(['windows', 'linux', 'macos']);
var runnerAvailabilitySchema = external_exports.object({
  available: external_exports.boolean(),
  version: external_exports.string().optional()
});
var nonnegativeSafeIntegerSchema = external_exports
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
var positiveSafeIntegerSchema = external_exports.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
var boundedIdentifierSchema = external_exports.string().trim().min(1).max(128);
var utf8ByteLength = (value) => new TextEncoder().encode(value).byteLength;
var runtimeCredentialHttpVersionSchema = external_exports.enum(['1.1', '2']);
var marAgentResponsesServiceTierSchema = external_exports.enum([
  'auto',
  'default',
  'flex',
  'priority',
  'fast',
  'ultrafast'
]);
var marAgentRuntimeCredentialCapabilitySchema = external_exports
  .object({
    apiVersion: external_exports.literal(1),
    websocket: external_exports.boolean(),
    serviceTiers: external_exports
      .array(marAgentResponsesServiceTierSchema)
      .min(1)
      .max(6)
      .optional(),
    namespacedTools: external_exports.boolean().optional(),
    responsesOptionalParameters: external_exports.boolean().optional(),
    responsesHttpContinuation: external_exports.boolean().optional(),
    contextGcControl: external_exports.boolean().optional(),
    unifiedCompactControl: external_exports.boolean().optional(),
    conversationModels: external_exports.boolean().optional(),
    resourceInput: external_exports.boolean().optional(),
    httpVersions: external_exports
      .array(runtimeCredentialHttpVersionSchema)
      .min(1)
      .max(2)
      .superRefine((versions, context) => {
        if (new Set(versions).size !== versions.length)
          context.addIssue({ code: 'custom', message: 'HTTP versions must be unique' });
      })
  })
  .strict();
var conversationHostingCapabilitySchema = external_exports
  .object({
    state: external_exports.enum(['DISABLED', 'UNAVAILABLE', 'AVAILABLE']),
    apiVersion: external_exports.number().int().positive(),
    sandboxBackend: external_exports.literal('BUBBLEWRAP').optional(),
    sandboxPolicyVersion: external_exports.number().int().positive().optional(),
    acceptsNewConversations: external_exports.boolean(),
    supportsExistingConversations: external_exports.boolean(),
    capacity: external_exports.enum(['AVAILABLE', 'HIGH', 'FULL']),
    reasonCode: external_exports
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .optional()
  })
  .strict()
  .superRefine((capability, context) => {
    if (capability.state === 'AVAILABLE') {
      if (
        capability.sandboxBackend !== 'BUBBLEWRAP' ||
        capability.sandboxPolicyVersion === void 0 ||
        !capability.supportsExistingConversations ||
        capability.reasonCode !== void 0
      )
        context.addIssue({
          code: 'custom',
          message: 'available conversation hosting requires a healthy Bubblewrap backend'
        });
      if (capability.acceptsNewConversations !== (capability.capacity !== 'FULL'))
        context.addIssue({
          code: 'custom',
          path: ['acceptsNewConversations'],
          message: 'conversation hosting creation availability must match capacity'
        });
      return;
    }
    if (capability.acceptsNewConversations || capability.supportsExistingConversations)
      context.addIssue({
        code: 'custom',
        message: 'disabled or unavailable conversation hosting cannot run conversations'
      });
    if (capability.state === 'UNAVAILABLE' && capability.reasonCode === void 0)
      context.addIssue({
        code: 'custom',
        message: 'unavailable conversation hosting requires a reason'
      });
    if (
      capability.state === 'DISABLED' &&
      (capability.sandboxBackend !== void 0 ||
        capability.sandboxPolicyVersion !== void 0 ||
        capability.reasonCode !== void 0)
    )
      context.addIssue({
        code: 'custom',
        message: 'disabled conversation hosting cannot expose sandbox state'
      });
  });
var computerUseCapabilitySchema = external_exports
  .object({
    apiVersion: external_exports.literal(1),
    enabled: external_exports.boolean(),
    state: external_exports.enum(['DISABLED', 'INITIALIZING', 'AVAILABLE', 'UNAVAILABLE']),
    backend: external_exports.literal('PYAUTOGUI'),
    supportsScreenshot: external_exports.boolean(),
    supportsInput: external_exports.boolean(),
    supportsUnicodePaste: external_exports.boolean(),
    supportsPrimaryDisplay: external_exports.boolean(),
    runtimeVersion: external_exports.string().trim().min(1).max(128).optional(),
    reasonCode: external_exports
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .optional(),
    measuredAt: nonnegativeSafeIntegerSchema
  })
  .strict()
  .superRefine((capability, context) => {
    if (capability.state === 'DISABLED') {
      if (
        capability.enabled ||
        capability.reasonCode !== void 0 ||
        capability.supportsScreenshot ||
        capability.supportsInput ||
        capability.supportsUnicodePaste ||
        capability.supportsPrimaryDisplay
      )
        context.addIssue({
          code: 'custom',
          message: 'disabled Computer Use cannot expose runtime support'
        });
      return;
    }
    if (!capability.enabled)
      context.addIssue({
        code: 'custom',
        path: ['enabled'],
        message: 'active Computer Use states require enabled configuration'
      });
    if (capability.state === 'AVAILABLE') {
      if (
        capability.reasonCode !== void 0 ||
        !capability.supportsScreenshot ||
        !capability.supportsInput ||
        !capability.supportsUnicodePaste ||
        !capability.supportsPrimaryDisplay
      )
        context.addIssue({
          code: 'custom',
          message: 'available Computer Use requires complete desktop support'
        });
      return;
    }
    if (capability.state === 'INITIALIZING') {
      if (
        capability.reasonCode !== void 0 ||
        capability.supportsScreenshot ||
        capability.supportsInput ||
        capability.supportsUnicodePaste ||
        capability.supportsPrimaryDisplay
      )
        context.addIssue({
          code: 'custom',
          message: 'initializing Computer Use cannot expose a completed probe'
        });
      return;
    }
    if (capability.reasonCode === void 0)
      context.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'unavailable Computer Use requires a reason code'
      });
  });
var computerUseEnableInputSchema = external_exports
  .object({ enabled: external_exports.literal(true) })
  .strict();
var computerUseDisableInputSchema = external_exports.object({}).strict();
var computerUseEnableResultSchema = external_exports
  .object({ capability: computerUseCapabilitySchema })
  .strict();
var conversationHostingEnableInputSchema = external_exports
  .object({
    enabled: external_exports.literal(true)
  })
  .strict();
var conversationHostingDisableInputSchema = external_exports.object({}).strict();
var conversationHostingEnableResultSchema = external_exports
  .object({
    capability: conversationHostingCapabilitySchema
  })
  .strict();
var conversationHostingStorageCapacitySchema = external_exports
  .object({
    hostedStorageUsedBytes: nonnegativeSafeIntegerSchema,
    filesystemTotalBytes: positiveSafeIntegerSchema,
    filesystemAvailableBytes: nonnegativeSafeIntegerSchema,
    filesystemUsageBasisPoints: external_exports.number().int().min(0).max(1e4),
    capacity: external_exports.enum(['AVAILABLE', 'HIGH', 'FULL']),
    acceptsNewConversations: external_exports.boolean(),
    automaticCleanupInactiveDays: external_exports.number().int().min(1).max(365),
    measuredAt: nonnegativeSafeIntegerSchema
  })
  .strict()
  .superRefine((storage, context) => {
    if (storage.filesystemAvailableBytes > storage.filesystemTotalBytes)
      context.addIssue({
        code: 'custom',
        path: ['filesystemAvailableBytes'],
        message: 'available filesystem bytes cannot exceed total bytes'
      });
    const expectedUsageBasisPoints = Number(
      (BigInt(storage.filesystemTotalBytes - storage.filesystemAvailableBytes) * 10000n) /
        BigInt(storage.filesystemTotalBytes)
    );
    if (storage.filesystemUsageBasisPoints !== expectedUsageBasisPoints)
      context.addIssue({
        code: 'custom',
        path: ['filesystemUsageBasisPoints'],
        message: 'filesystem usage does not match total and available bytes'
      });
    const expected =
      storage.filesystemUsageBasisPoints >= 9500
        ? 'FULL'
        : storage.filesystemUsageBasisPoints >= 8500
          ? 'HIGH'
          : 'AVAILABLE';
    if (storage.capacity !== expected)
      context.addIssue({
        code: 'custom',
        path: ['capacity'],
        message: 'conversation hosting capacity does not match filesystem usage'
      });
    if (storage.acceptsNewConversations !== (storage.capacity !== 'FULL'))
      context.addIssue({
        code: 'custom',
        path: ['acceptsNewConversations'],
        message: 'conversation hosting creation availability does not match capacity'
      });
  });
var conversationHostingCleanupPreviewInputSchema = external_exports
  .object({
    inactiveDays: external_exports.number().int().min(1).max(365)
  })
  .strict();
var conversationHostingCleanupPreviewSchema = external_exports
  .object({
    inactiveDays: external_exports.number().int().min(1).max(365),
    cutoffAt: nonnegativeSafeIntegerSchema,
    candidateConversationCount: nonnegativeSafeIntegerSchema,
    reclaimableBytes: nonnegativeSafeIntegerSchema,
    measuredAt: nonnegativeSafeIntegerSchema
  })
  .strict();
var conversationHostingCleanupResultSchema = external_exports
  .object({
    inactiveDays: external_exports.number().int().min(1).max(365),
    cutoffAt: nonnegativeSafeIntegerSchema,
    deletedConversationCount: nonnegativeSafeIntegerSchema,
    releasedBytes: nonnegativeSafeIntegerSchema,
    skippedConversationCount: nonnegativeSafeIntegerSchema,
    completedAt: nonnegativeSafeIntegerSchema
  })
  .strict();
var runtimeCommandSchema = external_exports
  .object({
    id: external_exports.enum(['npx', 'git', 'python', 'pip']),
    command: external_exports.string().trim().min(1).max(128),
    available: external_exports.boolean(),
    version: external_exports.string().trim().min(1).max(512).optional(),
    path: external_exports.string().trim().min(1).max(2048).optional()
  })
  .strict();
var nodeUpgradeStatusSchema = external_exports.object({
  state: external_exports.enum(['IDLE', 'WAITING_FOR_RUNS', 'READY_TO_RESTART', 'FAILED']),
  targetVersion: external_exports
    .string()
    .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u)
    .optional(),
  activeRunCount: external_exports.number().int().nonnegative().optional(),
  attemptId: external_exports.string().uuid().optional(),
  errorCode: external_exports.string().trim().min(1).max(80).optional(),
  updatedAt: external_exports.number().int().nonnegative()
});
var sessionAsideCapabilitySchema = external_exports
  .object({ apiVersion: external_exports.literal(1) })
  .strict();
var promptCompletionCapabilitySchema = external_exports
  .object({
    apiVersion: external_exports.literal(1),
    contextVersion: external_exports
      .union([external_exports.literal(2), external_exports.literal(3)])
      .optional(),
    automaticTriggers: external_exports.literal(true).optional()
  })
  .strict();
var nodeMetadataSchema = external_exports
  .object({
    platform: nodePlatformSchema.optional(),
    architecture: external_exports.string().trim().min(1).max(128).optional(),
    nodeAppVersion: external_exports.string().trim().min(1).max(128).optional(),
    nodeVersion: external_exports.string().trim().min(1).max(128).optional(),
    osRelease: external_exports.string().max(256).optional(),
    osVersion: external_exports.string().max(256).optional(),
    codex: runnerAvailabilitySchema.optional(),
    claudeCode: runnerAvailabilitySchema.optional(),
    openCode: runnerAvailabilitySchema.optional(),
    marAgent: runnerAvailabilitySchema.optional(),
    runtimeCommands: external_exports.array(runtimeCommandSchema).max(16).optional(),
    supervisedUpgrade: external_exports.boolean().optional(),
    upgradeProgress: external_exports
      .object({ apiVersion: external_exports.literal(1) })
      .strict()
      .optional(),
    upgradeAttemptId: external_exports.string().uuid().optional(),
    upgrade: nodeUpgradeStatusSchema.optional()
  })
  .partial()
  .strict()
  .optional();
var nodeCapabilitiesSchema = external_exports
  .object({
    platform: nodePlatformSchema,
    architecture: external_exports.string().min(1).max(128),
    nodeAppVersion: external_exports.string().trim().min(1).max(128).optional(),
    nodeVersion: external_exports.string().min(1).max(128),
    metadata: nodeMetadataSchema,
    codex: runnerAvailabilitySchema,
    claudeCode: runnerAvailabilitySchema,
    openCode: runnerAvailabilitySchema.optional(),
    marAgent: runnerAvailabilitySchema.optional(),
    conversationHosting: conversationHostingCapabilitySchema.optional(),
    computerUse: computerUseCapabilitySchema.optional(),
    marAgentRuntimeCredentials: marAgentRuntimeCredentialCapabilitySchema.optional(),
    promptCompletion: promptCompletionCapabilitySchema.optional(),
    chatgptLogin: chatgptLoginCapabilitySchema.optional(),
    workspaceDirectTransfer: workspaceDirectTransferCapabilitySchema.optional(),
    terminalDirect: terminalDirectCapabilitySchema.optional(),
    remoteDesktop: remoteDesktopCapabilitySchema.optional(),
    sessionAside: sessionAsideCapabilitySchema.optional(),
    sessionGroups: external_exports
      .object({ apiVersion: external_exports.literal(1) })
      .strict()
      .optional()
  })
  .superRefine((capabilities, context) => {
    if (
      capabilities.platform !== 'linux' &&
      capabilities.conversationHosting?.state === 'AVAILABLE'
    )
      context.addIssue({
        code: 'custom',
        path: ['conversationHosting'],
        message: 'conversation hosting is Linux-only'
      });
    if (
      capabilities.conversationHosting?.state === 'AVAILABLE' &&
      capabilities.marAgent?.available !== true
    )
      context.addIssue({
        code: 'custom',
        path: ['marAgent'],
        message: 'conversation hosting requires MAR Agent'
      });
  });
var workspaceKindSchema = external_exports.enum(['DIRECTORY', 'GIT_WORKSPACE']);
var gitSummarySchema = external_exports.object({
  repositoryRoot: external_exports.string().optional(),
  commonDir: external_exports.string(),
  head: external_exports.string(),
  branch: external_exports.string().nullable(),
  dirty: external_exports.boolean(),
  snapshot: external_exports.string()
});
var runnerNameSchema = external_exports.enum(['codex', 'claude-code', 'opencode', 'mar-agent']);
var workspaceSessionCleanupResultSchema = external_exports
  .object({
    deleted: nonnegativeSafeIntegerSchema,
    skipped: nonnegativeSafeIntegerSchema,
    failed: nonnegativeSafeIntegerSchema,
    timedOut: external_exports.literal(true).optional(),
    remaining: nonnegativeSafeIntegerSchema.optional(),
    deletedByRunner: external_exports
      .object({
        codex: nonnegativeSafeIntegerSchema,
        'claude-code': nonnegativeSafeIntegerSchema,
        opencode: nonnegativeSafeIntegerSchema,
        'mar-agent': nonnegativeSafeIntegerSchema
      })
      .partial()
      .strict()
  })
  .strict()
  .superRefine((result, context) => {
    if (result.remaining !== void 0 && result.timedOut !== true)
      context.addIssue({
        code: 'custom',
        path: ['remaining'],
        message: 'Remaining candidates are only reported for a time-limited cleanup'
      });
    const runnerDeleted = Object.values(result.deletedByRunner).reduce(
      (total, count2) => total + (count2 ?? 0),
      0
    );
    if (runnerDeleted !== result.deleted)
      context.addIssue({
        code: 'custom',
        path: ['deletedByRunner'],
        message: 'Runner deletion counts must equal the deleted total'
      });
  });
var runnerUsageStatusSchema = external_exports.object({
  runner: runnerNameSchema,
  available: external_exports.boolean(),
  reasonCode: external_exports.string().min(1).max(80).nullable()
});
var runnerUsageWindowSchema = external_exports.object({
  id: external_exports.string().min(1).max(80),
  label: external_exports.string().min(1).max(128),
  usedPercentage: external_exports.number().finite().min(0).max(100),
  resetsAt: external_exports.number().int().nonnegative().nullable()
});
var runnerUsageSchema = external_exports.object({
  runner: runnerNameSchema,
  windows: external_exports.array(runnerUsageWindowSchema).min(1).max(8),
  fetchedAt: external_exports.number().int().nonnegative(),
  cached: external_exports.boolean()
});
var runnerControlLevelSchema = external_exports.enum(['OBSERVE', 'MESSAGE', 'INTERRUPT']);
var runnerCapabilitiesSchema = external_exports.object({
  available: external_exports.boolean(),
  version: external_exports.string().max(128).optional(),
  controlLevel: runnerControlLevelSchema,
  supportsResume: external_exports.boolean(),
  supportsExternalSession: external_exports.boolean()
});
var runnerDefinitionSchema = external_exports.object({
  name: runnerNameSchema,
  capabilities: runnerCapabilitiesSchema
});
var marAgentModelProtocolSchema = external_exports.enum(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES']);
var marAgentInputCapabilitySchema = external_exports.enum(['TEXT', 'IMAGE']);
var marAgentOutputCapabilitySchema = external_exports.literal('TEXT');
var marAgentReasoningEffortSchema = external_exports.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
]);
var marAgentResponsesTransportSchema = external_exports.discriminatedUnion('transport', [
  external_exports.object({ transport: external_exports.literal('WEBSOCKET') }).strip(),
  external_exports
    .object({
      transport: external_exports.literal('HTTP'),
      httpVersion: runtimeCredentialHttpVersionSchema
    })
    .strip()
]);
var runtimeCredentialTicketSchema = external_exports
  .object({
    userId: positiveSafeIntegerSchema,
    credentialId: boundedIdentifierSchema,
    nodeId: boundedIdentifierSchema,
    workspaceId: boundedIdentifierSchema,
    sessionId: boundedIdentifierSchema.optional(),
    runtimeScopeId: boundedIdentifierSchema,
    allowedModelIds: external_exports.array(boundedIdentifierSchema).min(1).max(64),
    purpose: external_exports.enum(['MODEL', 'IMAGE_GENERATION']).optional(),
    issuedAt: nonnegativeSafeIntegerSchema,
    expiresAt: positiveSafeIntegerSchema,
    nonce: external_exports.string().min(1).max(128),
    signature: external_exports.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict()
  .superRefine((ticket, context) => {
    if (new Set(ticket.allowedModelIds).size !== ticket.allowedModelIds.length)
      context.addIssue({
        code: 'custom',
        path: ['allowedModelIds'],
        message: 'allowed model IDs must be unique'
      });
    if (
      ticket.expiresAt <= ticket.issuedAt ||
      ticket.expiresAt - ticket.issuedAt > 24 * 60 * 60 * 1e3
    )
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'runtime credential ticket lifetime is invalid'
      });
  });
var runtimeCredentialResolveRequestSchema = external_exports
  .object({
    ticket: runtimeCredentialTicketSchema,
    modelId: boundedIdentifierSchema,
    runtimeScopeId: boundedIdentifierSchema,
    executionId: boundedIdentifierSchema,
    reason: external_exports.enum(['REQUEST', 'UNAUTHORIZED', 'RECONNECT'])
  })
  .strict()
  .superRefine((request, context) => {
    if (request.runtimeScopeId !== request.ticket.runtimeScopeId)
      context.addIssue({
        code: 'custom',
        path: ['runtimeScopeId'],
        message: 'runtime scope must match the credential ticket'
      });
    if (!request.ticket.allowedModelIds.includes(request.modelId))
      context.addIssue({
        code: 'custom',
        path: ['modelId'],
        message: 'model is not allowed by the credential ticket'
      });
  });
var runtimeCredentialHeadersSchema = external_exports
  .record(
    external_exports
      .string()
      .min(1)
      .max(128)
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u),
    external_exports.string().max(16384)
  )
  .superRefine((headers, context) => {
    const entries = Object.entries(headers);
    if (entries.length > 32)
      context.addIssue({ code: 'custom', message: 'too many runtime credential headers' });
    const serializedSize = entries.reduce(
      (size, [name2, value]) => size + utf8ByteLength(name2) + utf8ByteLength(value),
      0
    );
    if (serializedSize > 65536)
      context.addIssue({ code: 'custom', message: 'runtime credential headers are too large' });
  });
var resolvedRuntimeCredentialSchema = external_exports
  .object({
    bearer: external_exports.string().min(1).max(65536),
    headers: runtimeCredentialHeadersSchema,
    socks5Url: external_exports
      .string()
      .url()
      .max(2048)
      .refine((value) => new URL(value).protocol === 'socks5:', 'SOCKS5 URL is required')
      .optional(),
    expiresAt: positiveSafeIntegerSchema,
    revision: positiveSafeIntegerSchema
  })
  .strict();
var runtimeCredentialResolveErrorSchema = external_exports
  .object({
    code: external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u),
    message: external_exports.string().min(1).max(512),
    recoverable: external_exports.boolean(),
    retryAfterMs: positiveSafeIntegerSchema.optional()
  })
  .strict();
var runtimeCredentialResolveResponseSchema = external_exports.union([
  external_exports
    .object({
      credential: resolvedRuntimeCredentialSchema,
      nextTicket: runtimeCredentialTicketSchema
    })
    .strict(),
  external_exports.object({ error: runtimeCredentialResolveErrorSchema }).strict()
]);
var scheduledRunAuthorizeRequestSchema = external_exports
  .object({
    executionResources: external_exports.literal(1).optional(),
    taskId: boundedIdentifierSchema,
    revision: positiveSafeIntegerSchema,
    occurrenceId: external_exports.string().min(1).max(256),
    sessionId: boundedIdentifierSchema,
    workspaceId: boundedIdentifierSchema,
    ownerUserId: positiveSafeIntegerSchema,
    runner: runnerNameSchema,
    modelId: external_exports.string().max(256).nullable()
  })
  .strict();
var executionPrepareRequestSchema = external_exports
  .object({
    userId: positiveSafeIntegerSchema,
    sessionId: boundedIdentifierSchema,
    workspaceId: boundedIdentifierSchema,
    runner: runnerNameSchema,
    modelId: external_exports.string().max(256).nullable()
  })
  .strict();
var executionPrepareResponseSchema = external_exports.union([
  external_exports
    .object({
      context: external_exports
        .object({
          usageGrant: modelUsageGrantSchema.optional(),
          secretEnvironment: external_exports.record(
            external_exports.string().min(1).max(256),
            external_exports.string().max(65536)
          ),
          personalInstructions: external_exports.unknown().optional(),
          gitConfiguration: personalGitRuntimeSchema.optional(),
          marAgentModel: external_exports.unknown().optional(),
          marAgentModels: external_exports.unknown().optional(),
          marAgentCompact: external_exports.unknown().optional(),
          marAgentRuntimeScopeId: external_exports.unknown().optional(),
          searchBackendAvailable: external_exports.boolean().optional()
        })
        .strict()
    })
    .strict(),
  external_exports
    .object({
      error: external_exports
        .object({
          code: external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
          message: external_exports.string().min(1).max(512)
        })
        .strict()
    })
    .strict()
]);
var marAgentInlineApiKeyCredentialSchema = external_exports
  .object({
    type: external_exports.literal('INLINE_API_KEY'),
    value: external_exports.string().min(1).max(16384)
  })
  .strict();
var marAgentModelCredentialSchema = external_exports.discriminatedUnion('type', [
  marAgentInlineApiKeyCredentialSchema,
  external_exports
    .object({
      type: external_exports.literal('CREDENTIAL_REF'),
      credentialId: boundedIdentifierSchema
    })
    .strict()
]);
var marAgentRuntimeCredentialSchema = external_exports.union([
  marAgentInlineApiKeyCredentialSchema,
  external_exports
    .object({
      type: external_exports.literal('RUNTIME_TICKET'),
      credentialId: boundedIdentifierSchema,
      ticket: runtimeCredentialTicketSchema
    })
    .strict()
    .superRefine((credential, context) => {
      if (credential.credentialId !== credential.ticket.credentialId)
        context.addIssue({
          code: 'custom',
          path: ['credentialId'],
          message: 'credential ID must match the runtime ticket'
        });
    })
]);
var marAgentImageGenerationSchema = external_exports
  .object({
    provider: external_exports.string().trim().min(1).max(64).optional(),
    config: external_exports
      .record(external_exports.string().min(1).max(128), external_exports.string().max(2048))
      .optional(),
    generateEndpoint: external_exports.string().url().max(2048),
    editEndpoint: external_exports.string().url().max(2048),
    imageModelId: external_exports.string().trim().min(1).max(256),
    httpVersion: external_exports.enum(['1.1', '2']),
    credential: marAgentRuntimeCredentialSchema.optional()
  })
  .strict();
var imageGenerationUrlSchema = external_exports
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)))
    );
  });
var imageGenerationConfigurationSchema = external_exports.discriminatedUnion('provider', [
  external_exports
    .object({
      provider: external_exports.literal('CODEX'),
      config: external_exports
        .object({
          credentialId: boundedIdentifierSchema,
          modelId: external_exports.string().trim().min(1).max(256)
        })
        .strict()
    })
    .strict(),
  external_exports
    .object({
      provider: external_exports.literal('BYTED_ARK'),
      config: external_exports
        .object({
          url: imageGenerationUrlSchema.optional(),
          modelId: external_exports.string().trim().min(1).max(256),
          apiKey: external_exports.string().trim().min(1).max(16384).optional(),
          hasApiKey: external_exports.boolean().optional()
        })
        .strict()
    })
    .strict()
]);
var imageGenerationModelFields = {
  id: boundedIdentifierSchema,
  name: external_exports.string().trim().min(1).max(128),
  enabled: external_exports.boolean(),
  ownership: resourceOwnershipSchema.optional(),
  sortOrder: external_exports.number().int().optional()
};
var imageGenerationModelSchema = external_exports.discriminatedUnion('provider', [
  imageGenerationConfigurationSchema.options[0].extend(imageGenerationModelFields),
  imageGenerationConfigurationSchema.options[1].extend(imageGenerationModelFields)
]);
var imageGenerationCatalogSchema = external_exports
  .array(imageGenerationModelSchema)
  .max(100)
  .superRefine((models, context) => {
    if (new Set(models.map((model) => model.id)).size !== models.length)
      context.addIssue({ code: 'custom', message: 'Image model IDs must be unique.' });
  });
var marAgentModelShape = {
  metadata: external_exports
    .object({ useResourceUrl: external_exports.boolean().default(false) })
    .strict()
    .optional(),
  id: external_exports.string().min(1).max(128),
  name: external_exports.string().trim().min(1).max(128),
  protocol: marAgentModelProtocolSchema,
  modelId: external_exports.string().trim().min(1).max(256),
  contextWindowTokens: external_exports.number().int().positive(),
  maxOutputTokens: external_exports.number().int().positive(),
  inputCapabilities: external_exports.array(marAgentInputCapabilitySchema).min(1).max(2),
  outputCapabilities: external_exports.tuple([marAgentOutputCapabilitySchema]),
  reasoningEfforts: external_exports.array(marAgentReasoningEffortSchema).max(6),
  defaultReasoningEffort: marAgentReasoningEffortSchema.optional(),
  conversationModel: external_exports.boolean().default(true),
  subagentModel: external_exports.boolean().default(false),
  unifiedCompact: external_exports.boolean().default(false),
  titleGeneration: external_exports.boolean().default(false),
  codeMode: external_exports.boolean().default(false),
  gcEnabled: external_exports.boolean().default(true),
  serviceTier: marAgentResponsesServiceTierSchema.optional(),
  hostedWebSearch: external_exports.boolean(),
  responsesTransport: marAgentResponsesTransportSchema.optional(),
  responsesPreviousResponseId: external_exports.boolean().default(false),
  enabled: external_exports.boolean()
};
function refineMarAgentModel(schema) {
  return schema.superRefine((value, context) => {
    if (!value.inputCapabilities.includes('TEXT'))
      context.addIssue({ code: 'custom', message: 'TEXT input is required' });
    if (value.maxOutputTokens >= value.contextWindowTokens)
      context.addIssue({ code: 'custom', message: 'output must be smaller than context' });
    if (new Set(value.reasoningEfforts).size !== value.reasoningEfforts.length)
      context.addIssue({ code: 'custom', message: 'reasoning efforts must be unique' });
    if (
      value.defaultReasoningEffort !== void 0 &&
      value.reasoningEfforts.length > 0 &&
      !value.reasoningEfforts.includes(value.defaultReasoningEffort)
    )
      context.addIssue({
        code: 'custom',
        path: ['defaultReasoningEffort'],
        message: 'default reasoning effort must be exposed when choices are configured'
      });
    if (value.protocol === 'ANTHROPIC_MESSAGES' && value.hostedWebSearch)
      context.addIssue({
        code: 'custom',
        message: 'Anthropic compatibility hosted web unsupported'
      });
    if (value.protocol !== 'OPENAI_RESPONSES' && value.responsesTransport !== void 0)
      context.addIssue({
        code: 'custom',
        message: 'Responses transport requires OpenAI Responses'
      });
    if (value.protocol !== 'OPENAI_RESPONSES' && value.responsesPreviousResponseId)
      context.addIssue({ code: 'custom', message: 'Responses continuation requires Responses' });
    if (value.protocol !== 'OPENAI_RESPONSES' && value.serviceTier !== void 0)
      context.addIssue({ code: 'custom', message: 'Service tier requires OpenAI Responses' });
  });
}
var marAgentModelSummaryShape = {
  ...marAgentModelShape,
  baseUrl: external_exports.string().url().max(2048),
  sortOrder: external_exports.number().int(),
  credentialType: external_exports.enum(['INLINE_API_KEY', 'CREDENTIAL_REF']).optional(),
  credentialConfigured: external_exports.boolean().optional(),
  lastTestedAt: external_exports.number().int().nonnegative().nullable().optional(),
  lastTestStatus: external_exports
    .enum(['UNVERIFIED', 'SUCCEEDED', 'FAILED'])
    .nullable()
    .optional(),
  lastTestCode: external_exports.string().max(80).nullable().optional()
};
var marAgentNodeModelSummarySchema = refineMarAgentModel(
  external_exports
    .object({
      ...marAgentModelSummaryShape,
      access: external_exports.never().optional(),
      apiKey: external_exports.never().optional(),
      credential: external_exports.never().optional(),
      imageGeneration: external_exports.never().optional()
    })
    .strip()
);
var marAgentModelSummarySchema = refineMarAgentModel(
  external_exports
    .object({
      ...marAgentModelSummaryShape,
      ownership: resourceOwnershipSchema.optional(),
      access: external_exports.enum(['PUBLIC', 'RESTRICTED'])
    })
    .strict()
);
var marAgentRuntimeModelConfigurationSchema = refineMarAgentModel(
  external_exports
    .object({
      ...marAgentModelShape,
      baseUrl: external_exports.string().url().max(2048),
      useResourceUrl: external_exports.boolean().default(false),
      credential: marAgentRuntimeCredentialSchema,
      responsesToolNamespace: external_exports
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u)
        .optional(),
      responsesConfigurationUpdates: external_exports.boolean().optional(),
      responsesOptionalParameters: external_exports
        .object({
          reasoningEffort: external_exports.boolean(),
          reasoningSummary: external_exports.boolean(),
          textVerbosity: external_exports.boolean(),
          promptCacheKey: external_exports.boolean(),
          nativeTools: external_exports.boolean().optional()
        })
        .strip()
        .optional(),
      imageGeneration: marAgentImageGenerationSchema.optional()
    })
    .strip()
).superRefine((configuration, context) => {
  if (
    configuration.responsesToolNamespace !== void 0 &&
    configuration.protocol !== 'OPENAI_RESPONSES'
  )
    context.addIssue({
      code: 'custom',
      path: ['responsesToolNamespace'],
      message: 'Tool namespaces require Standard OpenAI Responses'
    });
  if (
    configuration.imageGeneration !== void 0 &&
    configuration.imageGeneration.credential !== void 0 &&
    (configuration.imageGeneration.provider === 'BYTED_ARK'
      ? configuration.imageGeneration.credential.type !== 'INLINE_API_KEY'
      : configuration.imageGeneration.credential.type !== 'RUNTIME_TICKET' ||
        configuration.imageGeneration.credential.ticket.purpose !== 'IMAGE_GENERATION')
  )
    context.addIssue({
      code: 'custom',
      path: ['imageGeneration'],
      message: 'image generation requires an image-generation runtime ticket'
    });
});
var marAgentCompactConfigurationSchema = external_exports
  .object({
    enabled: external_exports.boolean(),
    modelId: boundedIdentifierSchema.nullable(),
    reasoningEffort: marAgentReasoningEffortSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabled && (value.modelId === null || value.reasoningEffort === null))
      context.addIssue({
        code: 'custom',
        message: 'Enabled compaction requires a model and reasoning effort'
      });
  });
var promptCompletionConfigurationSchema = external_exports
  .object({
    enabled: external_exports.boolean(),
    modelId: boundedIdentifierSchema.nullable(),
    reasoningEffort: marAgentReasoningEffortSchema.nullable()
  })
  .strict()
  .refine((value) => (value.modelId === null) === (value.reasoningEffort === null), {
    message: 'A completion model and reasoning effort must be configured together'
  });
var promptCompletionPreferencesSchema = external_exports
  .object({
    work: external_exports.boolean()
  })
  .strict();
var promptCompletionAttentionSchema = external_exports
  .object({
    fileId: boundedIdentifierSchema.optional(),
    worktreePath: external_exports.string().max(1024).optional(),
    kind: external_exports.enum(['FILE', 'DIFF']),
    path: external_exports.string().min(1).max(1024),
    observedAt: nonnegativeSafeIntegerSchema,
    revision: external_exports.string().min(1).max(128).optional(),
    startLine: external_exports.number().int().positive().max(1e7).optional(),
    endLine: external_exports.number().int().positive().max(1e7).optional(),
    source: external_exports.enum(['WORKING_TREE', 'HISTORY', 'TOOL_CHANGE']).optional()
  })
  .strict()
  .refine(
    (value) =>
      (value.startLine === void 0) === (value.endLine === void 0) &&
      (value.startLine === void 0 || value.endLine >= value.startLine),
    'Invalid visible range'
  );
var promptCompletionRequestSchema = external_exports
  .object({
    trigger: external_exports.enum(['MANUAL', 'AUTO']),
    completionMode: external_exports.enum(['NEXT', 'COMPLETE', 'REWRITE']),
    attention: external_exports.array(promptCompletionAttentionSchema).max(20).optional(),
    draft: external_exports
      .string()
      .max(8192)
      .refine((value) => utf8ByteLength(value) <= 8192),
    cursorPosition: nonnegativeSafeIntegerSchema,
    draftRevision: nonnegativeSafeIntegerSchema,
    contextVersion: boundedIdentifierSchema,
    historyGeneration: boundedIdentifierSchema,
    requestId: boundedIdentifierSchema,
    pageEpoch: boundedIdentifierSchema,
    intentSequence: positiveSafeIntegerSchema,
    runner: runnerNameSchema,
    sessionId: boundedIdentifierSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.trigger === 'AUTO' && value.draft !== '')
      context.addIssue({
        code: 'custom',
        path: ['draft'],
        message: 'Automatic prediction requires an empty draft'
      });
    const offset = value.cursorPosition;
    const before = value.draft.charCodeAt(offset - 1);
    const after = value.draft.charCodeAt(offset);
    if (
      offset > value.draft.length ||
      (before >= 55296 && before <= 56319 && after >= 56320 && after <= 57343)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['cursorPosition'],
        message: 'Invalid draft cursor'
      });
    }
    if ((value.completionMode === 'NEXT') !== (value.draft.length === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['completionMode'],
        message: 'Completion mode must match the draft'
      });
    }
  });
var promptCompletionCancelSchema = external_exports
  .object({
    requestId: boundedIdentifierSchema,
    pageEpoch: boundedIdentifierSchema,
    intentSequence: positiveSafeIntegerSchema
  })
  .strict();
var promptCompletionContextSchema = external_exports
  .object({
    contextVersion: boundedIdentifierSchema,
    historyGeneration: boundedIdentifierSchema,
    progressRevision: nonnegativeSafeIntegerSchema
  })
  .strict();
var promptCompletionResponseIdentity = {
  requestId: boundedIdentifierSchema,
  contextVersion: boundedIdentifierSchema,
  historyGeneration: boundedIdentifierSchema,
  draftRevision: nonnegativeSafeIntegerSchema,
  cursorPosition: nonnegativeSafeIntegerSchema
};
var promptCompletionResponseSchema = external_exports.discriminatedUnion('status', [
  external_exports
    .object({
      ...promptCompletionResponseIdentity,
      status: external_exports.literal('ready'),
      suggestion: external_exports.string().min(1).max(4e3),
      source: external_exports.enum(['generated', 'cache']),
      expiresAt: nonnegativeSafeIntegerSchema
    })
    .strict(),
  external_exports
    .object({ ...promptCompletionResponseIdentity, status: external_exports.literal('empty') })
    .strict(),
  external_exports
    .object({ ...promptCompletionResponseIdentity, status: external_exports.literal('cancelled') })
    .strict(),
  external_exports
    .object({
      ...promptCompletionResponseIdentity,
      status: external_exports.literal('skipped'),
      reason: external_exports.enum([
        'IN_FLIGHT',
        'RATE_LIMITED',
        'STALE_CONTEXT',
        'UNAVAILABLE',
        'CAPACITY'
      ]),
      retryAfterMs: nonnegativeSafeIntegerSchema.optional()
    })
    .strict()
]);
var promptCompletionTargetSchema = external_exports
  .object({ kind: external_exports.literal('WORKSPACE'), workspaceId: boundedIdentifierSchema })
  .strict();
var promptCompletionContextInputSchema = external_exports
  .object({
    target: promptCompletionTargetSchema,
    runner: runnerNameSchema,
    sessionId: boundedIdentifierSchema.nullable(),
    workbenchConnectionId: boundedIdentifierSchema,
    pageEpoch: boundedIdentifierSchema
  })
  .strict();
var promptCompletionGenerateInputSchema = external_exports
  .object({
    target: promptCompletionTargetSchema,
    workbenchConnectionId: boundedIdentifierSchema,
    request: promptCompletionRequestSchema
  })
  .strict();
var promptCompletionRuntimeSchema = external_exports
  .object({
    workspaceId: boundedIdentifierSchema,
    authorizationView: boundedIdentifierSchema,
    expiresAt: nonnegativeSafeIntegerSchema,
    runtimeScopeId: boundedIdentifierSchema,
    modelRevision: boundedIdentifierSchema,
    credentialScope: boundedIdentifierSchema,
    model: marAgentRuntimeModelConfigurationSchema,
    reasoningEffort: marAgentReasoningEffortSchema
  })
  .strict();
var marAgentRuntimeCompactConfigurationSchema = external_exports
  .object({
    model: marAgentRuntimeModelConfigurationSchema,
    reasoningEffort: marAgentReasoningEffortSchema
  })
  .strict();
var marAgentModelTransportTestInputSchema = external_exports
  .object({
    runtimeScopeId: boundedIdentifierSchema,
    executionId: boundedIdentifierSchema,
    model: marAgentRuntimeModelConfigurationSchema
  })
  .strict();
var marAgentModelTransportTestResultSchema = external_exports.discriminatedUnion('success', [
  external_exports
    .object({
      success: external_exports.literal(true),
      code: external_exports.null(),
      message: external_exports.null(),
      httpStatus: external_exports.null(),
      requestId: external_exports.string().min(1).max(128).optional()
    })
    .strict(),
  external_exports
    .object({
      success: external_exports.literal(false),
      code: external_exports.string().trim().min(1).max(80),
      message: external_exports.string().trim().min(1).max(1e3),
      httpStatus: external_exports.number().int().min(100).max(599).nullable(),
      requestId: external_exports.string().min(1).max(128).optional(),
      response: external_exports
        .object({
          body: external_exports.string().max(4096),
          bodyTruncated: external_exports.boolean(),
          contentType: external_exports.string().max(256).nullable(),
          requestId: external_exports.string().max(256).nullable(),
          retryAfter: external_exports.string().max(128).nullable()
        })
        .strict()
        .optional()
    })
    .strict()
]);
var marAgentStoredModelConfigurationSchema = refineMarAgentModel(
  external_exports
    .object({
      ...marAgentModelShape,
      baseUrl: external_exports.string().url().max(2048),
      credential: marAgentModelCredentialSchema
    })
    .strict()
);
var codexCredentialProxySummarySchema = external_exports.discriminatedUnion('configured', [
  external_exports.object({ configured: external_exports.literal(false) }).strict(),
  external_exports
    .object({
      configured: external_exports.literal(true),
      host: external_exports.string().trim().min(1).max(253),
      port: external_exports.number().int().min(1).max(65535),
      hasUsername: external_exports.boolean()
    })
    .strict()
]);
var codexCredentialOwnershipSchema = external_exports.discriminatedUnion('ownerType', [
  external_exports
    .object({
      ownerType: external_exports.literal('PERSONAL'),
      ownerUserId: positiveSafeIntegerSchema
    })
    .strict(),
  external_exports
    .object({
      ownerType: external_exports.literal('ORGANIZATION'),
      ownerOrganizationId: positiveSafeIntegerSchema
    })
    .strict()
]);
var codexCredentialSummarySchema = external_exports
  .object({
    id: boundedIdentifierSchema,
    name: external_exports.string().trim().min(1).max(128),
    type: external_exports.enum(['CODEX_OAUTH', 'CHATGPT_OAUTH', 'XAI_OAUTH']),
    authorization: external_exports.enum(['AUTHORIZED', 'UNAUTHORIZED']).optional(),
    ownership: codexCredentialOwnershipSchema,
    status: external_exports.enum(['ACTIVE', 'DEGRADED', 'REAUTH_REQUIRED']),
    accessTokenExpiresAt: nonnegativeSafeIntegerSchema.nullable(),
    earliestRefreshAt: nonnegativeSafeIntegerSchema.nullable().optional(),
    lastRefreshAt: nonnegativeSafeIntegerSchema.nullable(),
    lastCheckedAt: nonnegativeSafeIntegerSchema.nullable(),
    accountId: external_exports.string().trim().min(1).max(512),
    proxy: codexCredentialProxySummarySchema,
    revision: positiveSafeIntegerSchema
  })
  .strict();
var codexCredentialDetailsSchema = external_exports
  .object({
    credential: codexCredentialSummarySchema,
    socks5Url: external_exports.string().url().max(2048).nullable()
  })
  .strict()
  .superRefine((details, context) => {
    if (details.socks5Url === null) {
      if (details.credential.proxy.configured)
        context.addIssue({
          code: 'custom',
          path: ['socks5Url'],
          message: 'configured proxy requires a SOCKS5 URL'
        });
      return;
    }
    let url;
    try {
      url = new URL(details.socks5Url);
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['socks5Url'],
        message: 'valid SOCKS5 proxy URL is required'
      });
      return;
    }
    if (url.protocol !== 'socks5:') {
      context.addIssue({
        code: 'custom',
        path: ['socks5Url'],
        message: 'SOCKS5 proxy is required'
      });
      return;
    }
    const proxy = details.credential.proxy;
    if (
      !proxy.configured ||
      proxy.host !== url.hostname ||
      proxy.port !== Number(url.port || 1080) ||
      proxy.hasUsername !== url.username.length > 0
    )
      context.addIssue({
        code: 'custom',
        path: ['credential', 'proxy'],
        message: 'proxy summary must match the SOCKS5 URL'
      });
  });
var codexUsageDateSchema = external_exports.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
var codexUsageDailyBucketSchema = external_exports
  .object({
    startDate: codexUsageDateSchema,
    tokens: nonnegativeSafeIntegerSchema
  })
  .strict();
var codexUsageProfileSchema = external_exports
  .object({
    lifetimeTokens: nonnegativeSafeIntegerSchema.nullable(),
    currentDayTokens: nonnegativeSafeIntegerSchema.nullable(),
    lastSevenDaysTokens: nonnegativeSafeIntegerSchema.nullable(),
    statsAsOf: codexUsageDateSchema.nullable(),
    dailyUsageBuckets: external_exports.array(codexUsageDailyBucketSchema).max(730)
  })
  .strict()
  .superRefine((profile, context) => {
    const dates = profile.dailyUsageBuckets.map((bucket) => bucket.startDate);
    if (new Set(dates).size !== dates.length)
      context.addIssue({
        code: 'custom',
        path: ['dailyUsageBuckets'],
        message: 'daily usage dates must be unique'
      });
  });
var codexCredentialUsageSchema = runnerUsageSchema
  .extend({
    windows: external_exports.array(runnerUsageWindowSchema).max(8),
    profile: codexUsageProfileSchema,
    subscription: external_exports
      .object({
        provider: external_exports.literal('XAI'),
        period: external_exports.enum(['WEEKLY', 'MONTHLY', 'UNKNOWN']),
        startsAt: nonnegativeSafeIntegerSchema.nullable(),
        resetsAt: nonnegativeSafeIntegerSchema.nullable(),
        usedPercentage: external_exports.number().finite().min(0).max(100).nullable(),
        prepaidBalanceCents: nonnegativeSafeIntegerSchema.nullable()
      })
      .strict()
      .optional()
  })
  .superRefine((usage, context) => {
    if (!usage.subscription && usage.windows.length === 0)
      context.addIssue({ code: 'custom', message: 'Usage requires a window or subscription data' });
  });
var codexLoginAttemptSchema = external_exports
  .object({
    id: boundedIdentifierSchema,
    status: external_exports.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']),
    type: external_exports.enum(['CODEX_OAUTH', 'CHATGPT_OAUTH', 'XAI_OAUTH']).optional(),
    userCode: external_exports.string().trim().min(1).max(128).optional(),
    verificationUri: external_exports.string().url().max(2048).optional(),
    expiresAt: nonnegativeSafeIntegerSchema.optional(),
    pollIntervalMs: positiveSafeIntegerSchema.max(6e4).optional(),
    credentialId: boundedIdentifierSchema.optional(),
    code: external_exports
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/u)
      .optional(),
    message: external_exports.string().min(1).max(512).optional()
  })
  .strict()
  .superRefine((attempt, context) => {
    if (
      attempt.status === 'PENDING' &&
      ((attempt.type !== 'CHATGPT_OAUTH' && attempt.userCode === void 0) ||
        attempt.verificationUri === void 0 ||
        attempt.expiresAt === void 0 ||
        attempt.pollIntervalMs === void 0)
    )
      context.addIssue({ code: 'custom', message: 'pending login attempt is incomplete' });
    if (attempt.status === 'SUCCEEDED' && attempt.credentialId === void 0)
      context.addIssue({ code: 'custom', message: 'successful login attempt needs a credential' });
    if (attempt.status !== 'SUCCEEDED' && attempt.credentialId !== void 0)
      context.addIssue({
        code: 'custom',
        path: ['credentialId'],
        message: 'only a successful login attempt may expose a credential'
      });
  });
var codexModelCandidateSchema = external_exports
  .object({
    upstreamModelId: external_exports.string().trim().min(1).max(256),
    displayName: external_exports.string().trim().min(1).max(256),
    description: external_exports.string().max(4096).optional(),
    contextWindowTokens: positiveSafeIntegerSchema.optional(),
    maxOutputTokens: positiveSafeIntegerSchema.optional(),
    reasoningEfforts: external_exports.array(marAgentReasoningEffortSchema).max(6),
    defaultReasoningEffort: marAgentReasoningEffortSchema.optional(),
    unsupportedReasoningEfforts: external_exports
      .array(external_exports.string().trim().min(1).max(128))
      .max(16),
    inputCapabilities: external_exports.array(marAgentInputCapabilitySchema).min(1).max(2),
    hostedWebSearch: external_exports.boolean(),
    warnings: external_exports.array(external_exports.string().trim().min(1).max(512)).max(32),
    requiredInputs: external_exports.array(external_exports.literal('contextWindowTokens')).max(1)
  })
  .strict()
  .superRefine((model, context) => {
    if (new Set(model.reasoningEfforts).size !== model.reasoningEfforts.length)
      context.addIssue({ code: 'custom', message: 'reasoning efforts must be unique' });
    if (
      model.defaultReasoningEffort !== void 0 &&
      model.reasoningEfforts.length > 0 &&
      !model.reasoningEfforts.includes(model.defaultReasoningEffort)
    )
      context.addIssue({
        code: 'custom',
        path: ['defaultReasoningEffort'],
        message: 'default reasoning effort must be exposed when choices are configured'
      });
    if (
      new Set(model.unsupportedReasoningEfforts).size !== model.unsupportedReasoningEfforts.length
    )
      context.addIssue({ code: 'custom', message: 'unsupported reasoning efforts must be unique' });
    if (new Set(model.inputCapabilities).size !== model.inputCapabilities.length)
      context.addIssue({ code: 'custom', message: 'input capabilities must be unique' });
    if (new Set(model.requiredInputs).size !== model.requiredInputs.length)
      context.addIssue({ code: 'custom', message: 'required inputs must be unique' });
    if (
      model.contextWindowTokens !== void 0 &&
      model.maxOutputTokens !== void 0 &&
      model.maxOutputTokens >= model.contextWindowTokens
    )
      context.addIssue({ code: 'custom', message: 'output must be smaller than context' });
    if (
      model.requiredInputs.includes('contextWindowTokens') !==
      (model.contextWindowTokens === void 0)
    )
      context.addIssue({
        code: 'custom',
        path: ['requiredInputs'],
        message: 'context window requirement does not match the catalog value'
      });
  });
var codexModelCatalogSchema = external_exports
  .object({
    catalogHash: external_exports.string().regex(/^[a-f0-9]{64}$/u),
    fetchedAt: nonnegativeSafeIntegerSchema,
    models: external_exports.array(codexModelCandidateSchema).max(256)
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = catalog.models.map((model) => model.upstreamModelId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', path: ['models'], message: 'model IDs must be unique' });
  });
var codexModelImportItemSchema = external_exports
  .object({
    upstreamModelId: external_exports.string().trim().min(1).max(256),
    name: external_exports.string().trim().min(1).max(128).optional(),
    contextWindowTokens: positiveSafeIntegerSchema.optional(),
    enabled: external_exports.boolean()
  })
  .strict();
var codexModelImportRequestSchema = external_exports
  .object({
    catalogHash: external_exports.string().regex(/^[a-f0-9]{64}$/u),
    ownership: resourceOwnershipSchema.optional(),
    models: external_exports.array(codexModelImportItemSchema).min(1).max(64)
  })
  .strict()
  .superRefine((request, context) => {
    const ids = request.models.map((model) => model.upstreamModelId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', path: ['models'], message: 'model IDs must be unique' });
  });
var codexModelImportResultItemSchema = external_exports
  .object({
    upstreamModelId: external_exports.string().trim().min(1).max(256),
    status: external_exports.enum(['CREATED', 'UPDATED', 'UNCHANGED', 'BLOCKED']),
    modelId: boundedIdentifierSchema.optional(),
    code: external_exports
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/u)
      .optional()
  })
  .strict()
  .superRefine((item, context) => {
    if (item.status === 'BLOCKED') {
      if (item.modelId !== void 0)
        context.addIssue({ code: 'custom', path: ['modelId'], message: 'blocked model has no ID' });
      if (item.code === void 0)
        context.addIssue({ code: 'custom', path: ['code'], message: 'blocked model needs a code' });
      return;
    }
    if (item.modelId === void 0)
      context.addIssue({
        code: 'custom',
        path: ['modelId'],
        message: 'imported model needs an ID'
      });
    if (item.code !== void 0)
      context.addIssue({ code: 'custom', path: ['code'], message: 'imported model has no error' });
  });
var codexModelImportResultSchema = external_exports
  .object({
    items: external_exports.array(codexModelImportResultItemSchema).min(1).max(64)
  })
  .strict();
var agentRunStatusSchema = external_exports.enum([
  'STARTING',
  'RUNNING',
  'CANCELLING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED'
]);
var workspaceSessionNavigationQuerySchema = external_exports
  .object({
    sessionIds: external_exports.array(external_exports.string().min(1).max(512)),
    summaryAnchors: external_exports.array(external_exports.string().min(1).max(512)),
    treeAnchor: external_exports.string().min(1).max(512).optional(),
    limit: external_exports.number().int().min(1).max(100)
  })
  .strict();
var recentRunSchema = external_exports.object({
  runId: external_exports.string().min(1).max(128),
  nodeId: external_exports.string().min(1).max(128),
  workspaceId: external_exports.string().min(1).max(128),
  workspaceName: external_exports.string().max(128).optional(),
  sessionId: external_exports.string().min(1).max(128),
  sessionTitle: external_exports.string().min(1).max(160),
  sessionGroup: external_exports.enum(['MAIN', 'CHILD']).optional(),
  userMessage: external_exports.string().max(500).optional(),
  runner: runnerNameSchema,
  status: agentRunStatusSchema,
  interruptionReason: external_exports.literal('USER_STOP').optional(),
  createdAt: external_exports.number().int().nonnegative(),
  startedAt: external_exports.number().int().nonnegative(),
  completedAt: external_exports.number().int().nonnegative().nullable(),
  sortAt: external_exports.number().int().nonnegative(),
  updatedAt: external_exports.number().int().nonnegative(),
  version: external_exports.number().int().nonnegative()
});
var recentRunProjectionSchema = recentRunSchema
  .omit({ workspaceName: true })
  .extend({ userId: external_exports.number().int().positive() });
var recentRunProjectionMessageSchema = external_exports.discriminatedUnion('kind', [
  external_exports.object({
    kind: external_exports.literal('UPDATE'),
    run: recentRunProjectionSchema
  }),
  external_exports.object({
    kind: external_exports.literal('SNAPSHOT'),
    runs: external_exports.array(recentRunProjectionSchema)
  })
]);
var workspaceQueueItemSchema = external_exports.object({
  queueItemId: external_exports.string().min(1).max(128),
  sessionId: external_exports.string().min(1).max(128),
  workspaceId: external_exports.string().min(1).max(128),
  runner: runnerNameSchema,
  clientMessageId: external_exports.string().min(1).max(128),
  sessionTitle: external_exports.string().max(160),
  content: external_exports.string().min(1).max(2e4),
  createdAt: external_exports.number().int().nonnegative()
});
var workspaceQueueSchema = external_exports.object({
  version: external_exports.number().int().nonnegative(),
  paused: external_exports.boolean(),
  items: external_exports.array(workspaceQueueItemSchema)
});
var runEventSchema = external_exports.object({
  runId: external_exports.string().min(1).max(128),
  sequence: external_exports.number().int().positive(),
  eventType: external_exports.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  payload: external_exports.unknown(),
  status: agentRunStatusSchema.optional(),
  createdAt: external_exports.number().int().nonnegative().optional(),
  version: external_exports.number().int().nonnegative().optional()
});
var runPerformanceSchema = external_exports
  .object({
    runId: external_exports.string().min(1).max(128),
    latencyMs: external_exports.number().int().nonnegative().optional(),
    tokensPerSecond: external_exports.number().finite().nonnegative().optional()
  })
  .refine((value) => value.latencyMs !== void 0 || value.tokensPerSecond !== void 0);
var workbenchEventCategorySchema = external_exports.enum([
  'node',
  'session',
  'conversation',
  'hosted-conversation',
  'run',
  'queue',
  'workspace'
]);
var workbenchEventSchema = external_exports.object({
  sequence: external_exports.number().int().positive(),
  category: workbenchEventCategorySchema,
  payload: external_exports.unknown()
});
var watchAcceptedSchema = external_exports
  .object({
    accepted: external_exports.literal(true),
    watchId: external_exports.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    nodeGeneration: external_exports.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    expiresAt: external_exports.number().int().positive()
  })
  .strict();
var watchEventIdentitySchema = external_exports
  .object({
    workbenchConnectionId: external_exports.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    watchId: external_exports.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    nodeGeneration: external_exports.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    nodeId: external_exports.string().min(1).max(160)
  })
  .strict();
var hostedConversationWatchIdentitySchema = watchEventIdentitySchema.extend({
  templateId: external_exports.string().min(1).max(160)
});
var watchFailedEventSchema = watchEventIdentitySchema
  .extend({
    type: external_exports.literal('watch.failed'),
    watchType: external_exports.enum(['workspace', 'session', 'hosted-conversation']),
    workspaceId: external_exports.string().min(1).max(160).optional(),
    sessionId: external_exports.string().min(1).max(512).optional(),
    conversationId: external_exports.string().min(1).max(160).optional(),
    templateId: external_exports.string().min(1).max(160).optional(),
    topic: external_exports.enum(['sessions', 'files', 'changes', 'sessionNavigation']).optional(),
    code: external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    message: external_exports.string().min(1).max(1e3)
  })
  .superRefine((event, context) => {
    const valid =
      (event.watchType === 'workspace' &&
        event.workspaceId !== void 0 &&
        event.sessionId === void 0 &&
        event.conversationId === void 0 &&
        event.templateId === void 0) ||
      (event.watchType === 'session' &&
        event.workspaceId !== void 0 &&
        event.sessionId !== void 0 &&
        event.conversationId === void 0 &&
        event.templateId === void 0 &&
        event.topic === void 0) ||
      (event.watchType === 'hosted-conversation' &&
        event.workspaceId === void 0 &&
        event.sessionId === void 0 &&
        event.conversationId !== void 0 &&
        event.templateId !== void 0 &&
        event.topic === void 0);
    if (!valid)
      context.addIssue({
        code: 'custom',
        message: 'watch failure identity does not match the watch type'
      });
  });
var watchEventSchema = external_exports.union([
  watchEventIdentitySchema.extend({
    type: external_exports.literal('watch.workspace.snapshot'),
    workspaceId: external_exports.string().min(1).max(160),
    topic: external_exports.enum(['sessions', 'files', 'changes', 'sessionNavigation']),
    revision: external_exports.number().int().nonnegative(),
    snapshotSequence: external_exports.number().int().positive(),
    expiresAt: external_exports.number().int().positive(),
    payload: external_exports.unknown()
  }),
  watchEventIdentitySchema.extend({
    type: external_exports.literal('watch.session.snapshot'),
    workspaceId: external_exports.string().min(1).max(160),
    sessionId: external_exports.string().min(1).max(512),
    historyReset: external_exports.literal(true).optional(),
    revision: external_exports.number().int().nonnegative(),
    snapshotSequence: external_exports.number().int().positive(),
    expiresAt: external_exports.number().int().positive(),
    payload: external_exports.unknown()
  }),
  watchEventIdentitySchema.extend({
    type: external_exports.literal('watch.session.event'),
    workspaceId: external_exports.string().min(1).max(160),
    sessionId: external_exports.string().min(1).max(512),
    expiresAt: external_exports.number().int().positive(),
    event: workbenchEventSchema
  }),
  hostedConversationWatchIdentitySchema.extend({
    type: external_exports.literal('watch.hosted-conversation.snapshot'),
    conversationId: external_exports.string().min(1).max(160),
    revision: external_exports.number().int().nonnegative(),
    snapshotSequence: external_exports.number().int().positive(),
    expiresAt: external_exports.number().int().positive(),
    payload: external_exports.unknown()
  }),
  hostedConversationWatchIdentitySchema.extend({
    type: external_exports.literal('watch.hosted-conversation.event'),
    conversationId: external_exports.string().min(1).max(160),
    expiresAt: external_exports.number().int().positive(),
    event: workbenchEventSchema
  }),
  watchFailedEventSchema
]);
var capabilityAvailabilityBaseSchema = external_exports.object({
  available: external_exports.boolean(),
  reasonCode: external_exports.string().min(1).max(80).nullable()
});
function refineCapabilityAvailability(schema) {
  return schema.superRefine((value, context) => {
    if (value.available && value.reasonCode !== null) {
      context.addIssue({ code: 'custom', message: 'available capability cannot have reasonCode' });
    }
    if (!value.available && value.reasonCode === null) {
      context.addIssue({ code: 'custom', message: 'unavailable capability requires reasonCode' });
    }
  });
}
function capabilitySchemaWith(shape) {
  return refineCapabilityAvailability(capabilityAvailabilityBaseSchema.extend(shape));
}
var capabilityAvailabilitySchema = refineCapabilityAvailability(capabilityAvailabilityBaseSchema);
var runnerCommandDescriptorSchema = external_exports
  .object({
    id: external_exports.string().min(1).max(128),
    runner: runnerNameSchema,
    label: external_exports.string().min(1).max(128),
    stateLabel: external_exports.string().min(1).max(128).optional(),
    description: external_exports.string().max(500),
    /** Commands are entered exactly as the Runner documents them: `/name args`. */
    inputHint: external_exports.string().max(200),
    source: external_exports.enum([
      'CODEX_APP_SERVER',
      'CLAUDE_AGENT_SDK',
      'OPENCODE_SERVER',
      'MAR_RUNTIME'
    ]),
    interaction: external_exports.enum([
      'RUNNER_TEXT',
      'IMMEDIATE_ACTION',
      'DESTRUCTIVE_ACTION',
      'TOGGLE',
      'VALUE'
    ]),
    available: external_exports.boolean(),
    reasonCode: external_exports.string().min(1).max(80).nullable()
  })
  .superRefine((value, context) => {
    if (value.available && value.reasonCode !== null) {
      context.addIssue({ code: 'custom', message: 'available command cannot have reasonCode' });
    }
    if (!value.available && value.reasonCode === null) {
      context.addIssue({ code: 'custom', message: 'unavailable command requires reasonCode' });
    }
  });
var runnerCommandStateSchema = external_exports.object({
  commandId: external_exports.string().min(1).max(128),
  active: external_exports.boolean(),
  label: external_exports.string().min(1).max(128),
  detail: external_exports.string().max(500).nullable(),
  closable: external_exports.boolean(),
  closeInput: external_exports.string().min(2).max(2e4).nullable(),
  goal: external_exports
    .object({
      id: external_exports.string().uuid(),
      objective: external_exports.string().min(1).max(2e4),
      revision: external_exports.number().int().positive(),
      status: external_exports.enum(['active', 'completed', 'blocked']),
      turns: external_exports.number().int().nonnegative().optional()
    })
    .optional(),
  /** A Node-declared, fixed continuation for a completed structured result. */
  continuation: external_exports
    .object({
      label: external_exports.string().min(1).max(128),
      prompt: external_exports.string().min(1).max(2e4)
    })
    .nullable()
    .optional()
});
var runnerProfileSchema = external_exports.object({
  runner: runnerNameSchema,
  models: external_exports.array(
    external_exports.object({
      id: external_exports.string().min(1).max(128),
      label: external_exports.string().min(1).max(128),
      supportedEfforts: external_exports.array(external_exports.string().min(1).max(64)).max(32),
      isDefault: external_exports.boolean().optional(),
      defaultEffort: external_exports.string().min(1).max(64).optional(),
      subagentModel: external_exports.boolean().optional()
    })
  ),
  accessOptions: external_exports.array(
    external_exports.object({
      id: external_exports.string().min(1).max(128),
      label: external_exports.string().min(1).max(128),
      description: external_exports.string().max(500)
    })
  ),
  commands: external_exports.array(runnerCommandDescriptorSchema),
  capabilities: external_exports.array(external_exports.string().min(1).max(80)).max(64)
});
var runnerDefaultConfigurationSchema = external_exports
  .object({
    runner: runnerNameSchema,
    modelId: external_exports.string().trim().min(1).max(128),
    /** Runners without a reasoning-variant dimension persist an empty effort value. */
    effort: external_exports.string().trim().max(64),
    access: external_exports.string().trim().min(1).max(128)
  })
  .strict();
var runnerCommandExecutionSchema = external_exports.object({
  commandId: external_exports.string().min(1).max(128),
  input: external_exports.string().min(2).max(2e4)
});
var serverWorkbenchCapabilitiesSchema = external_exports.object({
  workbenchProtocolVersion: external_exports.literal(WORKBENCH_PROTOCOL_VERSION),
  serverVersion: external_exports.string().trim().min(1).max(128).optional(),
  conversationItemVersions: external_exports.array(external_exports.literal(2)).min(1),
  supportsSessionDetailStream: external_exports.boolean(),
  supportsTerminalBrowserRelay: external_exports.boolean(),
  supportsTerminalNodeDataChannel: external_exports.boolean(),
  maxSseSubscriptionsPerUser: external_exports.number().int().positive().max(128),
  maxTerminalBrowserConnectionsPerUser: external_exports.number().int().nonnegative().max(32)
});
var nodeWorkbenchCapabilitiesSchema = external_exports.object({
  manifestVersion: external_exports.literal(1),
  revision: external_exports.number().int().nonnegative(),
  observedAt: external_exports.number().int().nonnegative(),
  nodeGeneration: external_exports.string().min(8).max(128).optional(),
  platform: nodePlatformSchema,
  architecture: external_exports.string().min(1).max(128),
  conversation: capabilitySchemaWith({
    itemVersions: external_exports.array(external_exports.literal(2)).min(1),
    supportsSessionCursor: external_exports.boolean(),
    supportsHistoryPaging: external_exports.boolean(),
    supportsItemFinalSnapshots: external_exports.boolean(),
    maxPageSize: external_exports.number().int().positive().max(500)
  }),
  runners: external_exports.array(runnerProfileSchema),
  files: capabilitySchemaWith({
    supportsList: external_exports.boolean(),
    supportsReadRange: external_exports.boolean(),
    supportsSearch: external_exports.boolean(),
    maxDirectoryPageSize: external_exports.number().int().positive().max(1e3),
    maxReadBytes: external_exports.number().int().positive(),
    maxSearchResults: external_exports.number().int().positive().max(1e4)
  }),
  directTransfer: workspaceDirectTransferCapabilitySchema.optional(),
  terminalDirect: terminalDirectCapabilitySchema.optional(),
  remoteDesktop: remoteDesktopCapabilitySchema.optional(),
  sessionAside: sessionAsideCapabilitySchema.optional(),
  sessionGroups: external_exports
    .object({ apiVersion: external_exports.literal(1) })
    .strict()
    .optional(),
  git: capabilitySchemaWith({
    supportsCurrentChanges: external_exports.boolean(),
    supportsTurnChanges: external_exports.boolean(),
    supportsHistory: external_exports.boolean().optional(),
    maxDiffBytes: external_exports.number().int().positive()
  }),
  terminal: capabilitySchemaWith({
    supportsPty: external_exports.boolean(),
    supportsConPty: external_exports.boolean(),
    supportsReplay: external_exports.boolean(),
    supportsReadonlyAttach: external_exports.boolean(),
    supportsTakeover: external_exports.boolean(),
    maxTerminals: external_exports.number().int().nonnegative().max(64),
    maxReplayBytes: external_exports.number().int().nonnegative(),
    reconnectWindowMs: external_exports.number().int().nonnegative(),
    profiles: external_exports.array(
      external_exports.object({
        id: external_exports.string().min(1).max(128),
        label: external_exports.string().min(1).max(128),
        isDefault: external_exports.boolean()
      })
    )
  })
});
var sessionRuntimeCapabilitySchema = external_exports.enum([
  'history.read',
  'events.live',
  'turn.start',
  'turn.queue',
  'turn.interrupt',
  'run.cancel',
  'approval.respond',
  'user-input.respond',
  'session.rename',
  'session.rewind',
  'session.rollback',
  'session.remove',
  'session.pin',
  'session.schedule',
  'session.prompt'
]);
var sessionRuntimeCapabilitiesSchema = external_exports.object({
  level: external_exports.literal('MANAGED'),
  capabilities: external_exports.array(sessionRuntimeCapabilitySchema),
  reasonCode: external_exports.string().min(1).max(80).nullable()
});
var sessionActivityStateSchema = external_exports.enum(['MANAGED_ACTIVE', 'IDLE']);
var eventCursorSchema = external_exports.object({
  scope: external_exports.enum(['RUN', 'SESSION', 'WORKSPACE_ACTIVITY']),
  streamId: external_exports.string().min(1).max(128),
  cursor: external_exports.string().min(1).max(1024)
});
var permissionStopSchema = external_exports.object({
  action: external_exports.enum(['ask', 'deny']),
  reason: external_exports
    .string()
    .trim()
    .min(1)
    .refine((value) => [...value].length <= 240),
  source: external_exports.object({
    sessionId: external_exports.string().min(1).max(128),
    executionId: external_exports.string().min(1).max(128),
    callId: external_exports.string().min(1).max(128),
    toolName: external_exports.string().min(1).max(128),
    parentCallId: external_exports.string().min(1).max(128).optional()
  })
});
var conversationProcessGroupSchema = external_exports.object({
  id: external_exports.string().min(1).max(128),
  isStart: external_exports.literal(true).optional()
});
var conversationItemBaseSchema = external_exports.object({
  id: external_exports.string().min(1).max(128),
  sessionId: external_exports.string().min(1).max(128),
  turnId: external_exports.string().min(1).max(128),
  runId: external_exports.string().min(1).max(128).nullable(),
  parentItemId: external_exports.string().min(1).max(128).nullable(),
  sourceSequence: external_exports.number().int().positive().nullable(),
  revision: external_exports.number().int().nonnegative(),
  status: external_exports.enum([
    'PENDING',
    'IN_PROGRESS',
    'COMPLETED',
    'FAILED',
    'DECLINED',
    'CANCELLED',
    'INTERRUPTED'
  ]),
  startedAt: external_exports.number().int().nonnegative().nullable(),
  completedAt: external_exports.number().int().nonnegative().nullable(),
  segmentId: external_exports.string().min(1).max(256).optional(),
  segmentIndex: external_exports.number().int().nonnegative().optional(),
  processGroup: conversationProcessGroupSchema.optional(),
  permissionStop: permissionStopSchema.optional()
});
var contextReferenceSchema = external_exports.object({
  type: external_exports.enum([
    'file',
    'directory',
    'changes',
    'diff',
    'turn',
    'message',
    'terminal_selection'
  ]),
  referenceId: external_exports.string().min(1).max(128),
  label: external_exports.string().min(1).max(500),
  path: external_exports.string().min(1).max(4096).optional(),
  startLine: external_exports.number().int().positive().optional(),
  endLine: external_exports.number().int().positive().optional()
});
var imageRefSchema = external_exports
  .string()
  .min(1)
  .max(2048)
  .regex(/^(?:file|reader):[^\s]+$/u);
var conversationImageAttachmentSchema = external_exports
  .object({
    name: external_exports.string().trim().min(1).max(512),
    mime: external_exports.string().regex(/^image\/[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$/u),
    byteSize: external_exports.number().int().nonnegative().optional(),
    runId: external_exports.string().min(1).max(128).optional(),
    imageIndex: external_exports.number().int().nonnegative().optional(),
    imageRef: imageRefSchema.optional()
  })
  .strict()
  .superRefine((attachment2, context) => {
    const selectors =
      Number(attachment2.imageIndex !== void 0) + Number(attachment2.imageRef !== void 0);
    if (selectors > 1 || (attachment2.runId === void 0 ? selectors !== 0 : selectors !== 1))
      context.addIssue({
        code: 'custom',
        message: 'runId must be paired with exactly one image selector'
      });
  });
var assistantMessageItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('assistant_message'),
  payload: external_exports.object({
    text: external_exports.string(),
    format: external_exports.literal('markdown'),
    model: external_exports.string().max(128).nullable(),
    phase: external_exports.enum(['commentary', 'final_answer']).optional()
  })
});
var userMessageItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('user_message'),
  payload: external_exports.object({
    clientMessageId: external_exports.string().min(1).max(128).nullable(),
    text: external_exports.string(),
    contexts: external_exports.array(contextReferenceSchema).max(64).default([]),
    attachments: external_exports.array(conversationImageAttachmentSchema).max(32).optional(),
    source: external_exports.literal('SCHEDULED').optional(),
    delivery: external_exports.enum([
      'PENDING',
      'ACCEPTED',
      'STEERED',
      'QUEUED_NEXT_TURN',
      'REJECTED'
    ])
  })
});
var planItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('plan'),
  payload: external_exports.object({
    explanation: external_exports.string().nullable(),
    steps: external_exports.array(
      external_exports.object({
        id: external_exports.string().min(1).max(128),
        text: external_exports.string(),
        status: external_exports.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED'])
      })
    )
  })
});
var todoListItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('todo_list'),
  payload: external_exports.object({
    items: external_exports.array(
      external_exports.object({
        id: external_exports.string().min(1).max(128),
        text: external_exports.string(),
        status: external_exports.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED'])
      })
    )
  })
});
var approvalItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('approval'),
  payload: external_exports.object({
    approvalId: external_exports.string().min(1).max(128),
    category: external_exports.enum(['COMMAND', 'FILE_CHANGE', 'NETWORK', 'TOOL', 'OTHER']),
    reason: external_exports.string().nullable(),
    expiresAt: external_exports.number().int().nonnegative(),
    resolvedDecision: external_exports.string().nullable()
  })
});
var summaryItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('turn_summary'),
  payload: external_exports.object({
    status: agentRunStatusSchema,
    durationMs: external_exports.number().int().nonnegative().nullable()
  })
});
var reasoningItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('reasoning'),
  payload: external_exports.object({
    sections: external_exports.array(
      external_exports.object({
        index: external_exports.number().int().nonnegative(),
        text: external_exports.string()
      })
    ),
    representation: external_exports.enum(['summary', 'visible_thinking', 'unspecified'])
  })
});
var subagentOperationSchema = external_exports.enum([
  'START',
  'STATUS',
  'CANCEL',
  'MESSAGE',
  'RESUME'
]);
var subagentCallDetailSchema = external_exports.object({
  message: external_exports.string().min(1).max(2e3),
  messageTruncated: external_exports.literal(true).optional()
});
var agentOperationPresentationSchema = external_exports.object({
  action: external_exports.enum(['START', 'SEND', 'WAIT', 'STOP', 'LIST', 'VIEW']),
  targets: external_exports
    .array(
      external_exports.object({
        agentId: external_exports.string().min(1).max(128),
        sessionId: external_exports.string().min(1).max(128).optional(),
        title: external_exports.string().min(1).max(500).optional(),
        status: external_exports.string().min(1).max(128).optional(),
        message: external_exports.string().min(1).max(800).optional(),
        messageTruncated: external_exports.literal(true).optional()
      })
    )
    .max(100),
  targetsTruncated: external_exports.literal(true).optional(),
  scope: external_exports.string().min(1).max(32).optional(),
  detail: external_exports
    .object({
      title: external_exports.string().min(1).max(500).optional(),
      message: external_exports.string().min(1).max(2e3).optional(),
      messageIsGoal: external_exports.literal(true).optional(),
      messageTruncated: external_exports.literal(true).optional(),
      delivery: external_exports.enum(['QUEUE', 'STEER']).optional(),
      wait: external_exports
        .object({
          waitFor: external_exports.enum(['message', 'completion']),
          waitMs: external_exports.number().int().min(0).max(3e5),
          mode: external_exports.enum(['any', 'all']).optional()
        })
        .optional(),
      failed: external_exports.literal(true).optional(),
      error: external_exports.string().max(500).optional()
    })
    .optional()
});
var subagentLatestMessageSchema = external_exports.object({
  itemId: external_exports.string().min(1).max(128),
  turnId: external_exports.string().min(1).max(128),
  phase: external_exports.enum(['commentary', 'final_answer']),
  text: external_exports
    .string()
    .refine((value) => [...value].length <= 1e4, 'Must contain at most 10000 characters'),
  timestamp: external_exports.string().datetime(),
  truncated: external_exports.boolean().optional()
});
var executionOutputSchema = external_exports
  .array(
    external_exports
      .object({
        channel: external_exports.enum(['STDOUT', 'STDERR', 'COMBINED', 'TEXT']),
        text: external_exports.string().max(1e4)
      })
      .strict()
  )
  .max(4)
  .superRefine((blocks, ctx) => {
    const channels = blocks.map((block) => block.channel);
    if (
      new Set(channels).size !== channels.length ||
      (channels.includes('COMBINED') &&
        (channels.includes('STDOUT') || channels.includes('STDERR')))
    ) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: 'Conflicting output channels'
      });
    }
  });
var executionErrorSchema = external_exports
  .object({
    code: external_exports.string().min(1).max(80),
    message: external_exports.string().max(1e3)
  })
  .strict();
var executionTruncationSchema = external_exports
  .object({
    input: external_exports.boolean().optional(),
    output: external_exports.enum(['HEAD', 'SOURCE']).optional()
  })
  .strict();
var executionPresentationSchema = external_exports
  .object({
    kind: external_exports.literal('EXECUTION'),
    execution: external_exports
      .object({
        kind: external_exports.enum(['SHELL', 'CODE', 'CONTROL']),
        toolName: external_exports.string().min(1).max(128).optional(),
        action: external_exports.string().max(128).optional(),
        targetId: external_exports.string().max(256).optional(),
        source: external_exports
          .object({
            kind: external_exports.enum(['SHELL', 'CODE']),
            text: external_exports.string().max(1e4),
            cwd: external_exports.string().max(1e4).optional(),
            truncated: external_exports.boolean()
          })
          .strict()
          .optional(),
        output: executionOutputSchema.optional(),
        error: executionErrorSchema.optional(),
        truncation: executionTruncationSchema.optional()
      })
      .strict()
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 128 * 1024,
    'Execution presentation exceeds 128 KiB'
  );
var toolCallPresentationSchema = external_exports.discriminatedUnion('kind', [
  external_exports.object({
    kind: external_exports.literal('READ'),
    paths: external_exports.array(external_exports.string().min(1).max(4096)).max(16).optional(),
    results: external_exports
      .array(
        external_exports.object({
          path: external_exports.string().min(1).max(4096),
          startLine: external_exports.number().int().positive().optional(),
          endLine: external_exports.number().int().positive().optional(),
          empty: external_exports.literal(true).optional(),
          error: external_exports
            .object({
              code: external_exports.string().max(80),
              message: external_exports.string().max(1e3)
            })
            .optional(),
          contentRange: external_exports
            .object({
              channel: external_exports.enum(['TEXT', 'STDOUT', 'STDERR', 'COMBINED']),
              start: external_exports.number().int().min(0).max(1e4),
              end: external_exports.number().int().min(0).max(1e4)
            })
            .refine((range) => range.start <= range.end)
            .optional()
        })
      )
      .max(16)
      .optional()
  }),
  external_exports.object({
    kind: external_exports.literal('WEB_SEARCH'),
    detailOnly: external_exports.literal(true).optional(),
    sourcesOnly: external_exports.literal(true).optional(),
    query: external_exports.string().max(500).optional(),
    sourceCount: external_exports.number().int().nonnegative().optional(),
    sources: external_exports
      .array(
        external_exports.object({
          url: external_exports.string().min(1).max(8192),
          title: external_exports.string().max(1e3).optional(),
          snippet: external_exports.string().max(2e3).optional()
        })
      )
      .max(20)
      .optional()
  }),
  external_exports.object({
    kind: external_exports.literal('WEB_FETCH'),
    detailOnly: external_exports.literal(true).optional(),
    requestUrl: external_exports.string().max(8192).optional(),
    url: external_exports.string().max(8192).optional(),
    title: external_exports.string().max(1e3).optional(),
    mode: external_exports.enum(['http', 'browser']).optional(),
    status: external_exports.number().int().min(100).max(599).optional(),
    contentType: external_exports.string().max(256).optional()
  }),
  external_exports.object({
    kind: external_exports.literal('SKILL'),
    name: external_exports.string().max(128).optional(),
    description: external_exports.string().max(2e3).optional(),
    source: external_exports.string().max(4096).optional()
  }),
  external_exports.object({
    kind: external_exports.literal('IMAGE_VIEW'),
    path: external_exports.string().max(4096).optional(),
    resourceId: external_exports.string().max(512).optional(),
    mimeType: external_exports.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
    width: external_exports.number().int().positive().optional(),
    height: external_exports.number().int().positive().optional(),
    sourceWidth: external_exports.number().int().positive().optional(),
    sourceHeight: external_exports.number().int().positive().optional(),
    region: external_exports
      .object({
        x: external_exports.number().int().nonnegative(),
        y: external_exports.number().int().nonnegative(),
        width: external_exports.number().int().positive(),
        height: external_exports.number().int().positive()
      })
      .optional(),
    resize: external_exports
      .object({
        maxWidth: external_exports.number().int().positive().optional(),
        maxHeight: external_exports.number().int().positive().optional()
      })
      .optional()
  }),
  external_exports.object({
    kind: external_exports.literal('TOOL_SEARCH'),
    query: external_exports.string().max(500).optional(),
    tools: external_exports.array(external_exports.string().max(512)).max(20).optional()
  }),
  external_exports.object({
    kind: external_exports.literal('COMPACT_REQUEST'),
    accepted: external_exports.literal(true).optional()
  }),
  external_exports.object({
    kind: external_exports.literal('SLEEP'),
    durationMs: external_exports.number().int().min(1).max(18e5).optional(),
    startedAt: external_exports.string().datetime().optional(),
    elapsedMs: external_exports.number().int().nonnegative().optional(),
    wakeReason: external_exports.enum(['elapsed', 'steer', 'subagent_message']).optional()
  })
]);
var toolPresentationSchema = external_exports.union([
  toolCallPresentationSchema,
  executionPresentationSchema
]);
var toolOutputSchema = external_exports
  .object({
    blocks: executionOutputSchema,
    truncation: external_exports.enum(['HEAD', 'SOURCE']).optional()
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 128 * 1024,
    'Tool output exceeds 128 KiB'
  );
var toolOutputSnapshotSchema = external_exports
  .object({ text: external_exports.string().max(1e4), truncated: external_exports.boolean() })
  .strict();
var readableToolOutputSchema = external_exports.union([toolOutputSchema, toolOutputSnapshotSchema]);
var toolCallItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('tool_call'),
  payload: external_exports.object({
    namespace: external_exports.string().min(1).max(128),
    toolName: external_exports.string().min(1).max(128),
    title: external_exports.string().min(1).max(500),
    inputSummary: external_exports.string().max(1e4).nullable(),
    outputSummary: external_exports.string().max(1e4).nullable(),
    progressLabel: external_exports.string().max(500).nullable(),
    errorCode: external_exports.string().max(80).nullable(),
    errorMessage: external_exports.string().max(1e3).optional(),
    truncated: external_exports.boolean().optional(),
    inputTruncated: external_exports.literal(true).optional(),
    outputSummaryTruncated: external_exports.literal(true).optional(),
    output: readableToolOutputSchema.optional(),
    toolCategory: external_exports.enum(['IMAGE_GENERATION']).optional(),
    toolPresentation: toolCallPresentationSchema.optional(),
    agentOperation: agentOperationPresentationSchema.optional(),
    subagentOperation: subagentOperationSchema.optional(),
    subagentCallDetail: subagentCallDetailSchema.optional(),
    subagentWait: external_exports.boolean().optional(),
    subagentId: external_exports.string().min(1).max(128).nullable().optional(),
    subagentSessionId: external_exports.string().min(1).max(128).optional(),
    subagentModelId: external_exports.string().min(1).max(128).optional(),
    subagentModelName: external_exports.string().min(1).max(128).optional(),
    subagentReasoningEffort: external_exports
      .enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      .optional(),
    subagentLatestMessage: subagentLatestMessageSchema.optional(),
    attachments: external_exports.array(conversationImageAttachmentSchema).max(32).optional()
  })
});
var commandExecutionItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('command_execution'),
  payload: external_exports.object({
    toolName: external_exports.string().min(1).max(128).optional(),
    title: external_exports.string().min(1).max(128).optional(),
    command: external_exports.string().max(1e4),
    cwd: external_exports.string().max(4096).nullable(),
    outputPreview: external_exports.string().max(1e4).optional(),
    outputSummary: external_exports.string().max(1e4).nullable().optional(),
    outputSummaryTruncated: external_exports.literal(true).optional(),
    exitCode: external_exports.number().int().nullable(),
    durationMs: external_exports.number().int().nonnegative().nullable(),
    truncated: external_exports.boolean().optional(),
    output: readableToolOutputSchema.optional(),
    toolPresentation: executionPresentationSchema.optional()
  })
});
var fileChangeItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('file_change'),
  payload: external_exports.object({
    changes: external_exports.array(
      external_exports.object({
        path: external_exports.string().min(1).max(4096),
        change: external_exports.enum([
          'ADDED',
          'MODIFIED',
          'DELETED',
          'RENAMED',
          'COPIED',
          'TYPE_CHANGED'
        ]),
        additions: external_exports.number().int().nonnegative().nullable(),
        deletions: external_exports.number().int().nonnegative().nullable(),
        changeId: external_exports.string().uuid().optional(),
        diff: fileChangeDiffSchema.optional()
      })
    )
  })
});
var userInputRequestItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('user_input_request'),
  payload: external_exports.object({
    requestId: external_exports.string().min(1).max(128),
    questions: external_exports.array(
      external_exports.object({
        id: external_exports.string().min(1).max(128),
        prompt: external_exports.string().max(5e3),
        input: external_exports.enum(['SINGLE_SELECT', 'MULTI_SELECT', 'SHORT_TEXT']),
        options: external_exports.array(
          external_exports.object({
            value: external_exports.string().max(500),
            label: external_exports.string().max(500),
            description: external_exports.string().max(1e3).nullable()
          })
        ),
        allowOther: external_exports.boolean(),
        multiSelect: external_exports.boolean().optional()
      })
    )
  })
});
var contextCompactionItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('context_compaction'),
  payload: external_exports.object({
    phase: external_exports.enum(['STARTED', 'COMPLETED']),
    summary: external_exports.string().max(1e4).nullable(),
    mode: external_exports.enum(['BACKGROUND', 'BLOCKING']).optional(),
    stage: external_exports.enum(['GENERATING', 'READY', 'WAITING']).optional(),
    anchorItemId: external_exports.string().min(1).max(128).optional(),
    retainedContext: external_exports.boolean().optional(),
    code: external_exports.string().min(1).max(80).optional()
  })
});
var warningItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('warning'),
  payload: external_exports.object({
    code: external_exports.string().min(1).max(80),
    message: external_exports.string().max(5e3),
    recoverable: external_exports.boolean()
  })
});
var errorItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('error'),
  payload: external_exports.object({
    code: external_exports.string().min(1).max(80),
    message: external_exports.string().max(1e3),
    httpStatus: external_exports.number().int().min(100).max(599).nullable().optional(),
    recoverable: external_exports.boolean(),
    retryAfterMs: external_exports.number().int().nonnegative().nullable()
  })
});
var unknownItemSchema = conversationItemBaseSchema.extend({
  kind: external_exports.literal('unknown'),
  payload: external_exports.object({
    sourceEventType: external_exports.string().min(1).max(128),
    label: external_exports.string().max(500)
  })
});
var conversationItemSchema = external_exports.discriminatedUnion('kind', [
  assistantMessageItemSchema,
  userMessageItemSchema,
  reasoningItemSchema,
  planItemSchema,
  todoListItemSchema,
  toolCallItemSchema,
  commandExecutionItemSchema,
  fileChangeItemSchema,
  approvalItemSchema,
  userInputRequestItemSchema,
  contextCompactionItemSchema,
  warningItemSchema,
  errorItemSchema,
  summaryItemSchema,
  unknownItemSchema
]);
var conversationTurnSchema = external_exports.object({
  id: external_exports.string().min(1).max(128),
  sessionId: external_exports.string().min(1).max(128),
  runId: external_exports.string().min(1).max(128).nullable(),
  userItemId: external_exports.string().min(1).max(128).nullable(),
  status: external_exports.enum([
    'PREPARING',
    'RUNNING',
    'WAITING_INPUT',
    'WAITING_APPROVAL',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'INTERRUPTED',
    'LOST'
  ]),
  model: external_exports.string().max(128).nullable(),
  effort: external_exports.string().max(64).nullable(),
  access: external_exports.string().max(128).nullable(),
  rewind: external_exports
    .object({
      before: external_exports.string().min(1).max(256).nullable(),
      after: external_exports.string().min(1).max(256)
    })
    .optional(),
  items: external_exports.array(conversationItemSchema),
  startedAt: external_exports.number().int().nonnegative().nullable(),
  completedAt: external_exports.number().int().nonnegative().nullable()
});
var protocolIdSchema = external_exports.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
var stableStorageKeySchema = external_exports.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,159}$/);
var contentHashSchema = external_exports.string().regex(/^[a-f0-9]{64}$/);
var conversationRelativePathSchema = external_exports
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (path2) =>
      !path2.startsWith('/') &&
      !path2.includes('\\') &&
      !path2.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') &&
      !/^[A-Za-z]:/u.test(path2),
    'relative path is invalid'
  );
var uniqueProtocolIds = (values, context, path2) => {
  if (new Set(values).size !== values.length)
    context.addIssue({ code: 'custom', path: path2, message: 'identifiers must be unique' });
};
var BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var canonicalBase64 = (value) => {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding === 2) return BASE64_ALPHABET.indexOf(value.at(-3)) % 16 === 0;
  if (padding === 1) return BASE64_ALPHABET.indexOf(value.at(-2)) % 4 === 0;
  return true;
};
var base64DecodedByteLength = (value) => {
  if (value.length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length * 3) / 4 - padding;
};
var conversationTemplateStatusSchema = external_exports.enum(['ACTIVE', 'ARCHIVED', 'DELETED']);
var conversationTemplateVersionStatusSchema = external_exports.enum([
  'AVAILABLE',
  'DISABLED',
  'CORRUPTED',
  'RETAINED'
]);
var conversationTemplateNetworkModeSchema = external_exports.enum(['NONE', 'UNRESTRICTED']);
var conversationTemplateQuotaSchema = external_exports
  .object({
    maxStorageBytes: external_exports.number().int().positive(),
    maxUploadBytes: external_exports.number().int().positive()
  })
  .strict()
  .superRefine((quota, context) => {
    if (quota.maxUploadBytes > quota.maxStorageBytes)
      context.addIssue({ code: 'custom', message: 'upload quota exceeds storage quota' });
  });
var conversationTemplateModelReferenceSchema = external_exports
  .object({
    modelId: protocolIdSchema,
    name: external_exports.string().trim().min(1).max(128)
  })
  .strict();
var conversationTemplateDraftSchema = external_exports
  .object({
    templateId: protocolIdSchema,
    nodeId: protocolIdSchema,
    workspaceId: protocolIdSchema,
    revision: external_exports.number().int().positive(),
    name: external_exports.string().trim().min(1).max(128),
    description: external_exports.string().max(2e3),
    icon: external_exports.string().trim().min(1).max(128).optional(),
    allowedModels: external_exports.array(conversationTemplateModelReferenceSchema).min(1).max(128),
    defaultModelId: protocolIdSchema,
    mcpIds: external_exports.array(protocolIdSchema).max(128),
    networkMode: conversationTemplateNetworkModeSchema,
    quotas: conversationTemplateQuotaSchema,
    updatedAt: external_exports.number().int().nonnegative()
  })
  .strict()
  .superRefine((draft, context) => {
    uniqueProtocolIds(
      draft.allowedModels.map((model) => model.modelId),
      context,
      ['allowedModels']
    );
    uniqueProtocolIds(draft.mcpIds, context, ['mcpIds']);
    if (!draft.allowedModels.some((model) => model.modelId === draft.defaultModelId))
      context.addIssue({
        code: 'custom',
        path: ['defaultModelId'],
        message: 'default model must be allowed'
      });
  });
var conversationTemplateSourceInspectInputSchema = external_exports
  .object({
    mode: external_exports.enum(['VALIDATE', 'DRAFT_TEST']),
    draft: conversationTemplateDraftSchema
  })
  .strict();
var conversationTemplateMcpOptionSchema = external_exports
  .object({
    id: protocolIdSchema,
    serverName: external_exports.string().trim().min(1).max(255),
    displayName: external_exports.string().trim().min(1).max(128),
    transport: external_exports.enum(['STDIO', 'HTTP']),
    origin: external_exports.enum(['NODE', 'WORKSPACE'])
  })
  .strict();
var conversationTemplateSourceInspectionSchema = external_exports
  .object({
    valid: external_exports.boolean(),
    code: external_exports
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .nullable(),
    message: external_exports.string().min(1).max(1e3),
    checkedAt: external_exports.number().int().nonnegative(),
    mcpServers: external_exports.array(conversationTemplateMcpOptionSchema).max(128).default([])
  })
  .strict()
  .superRefine((inspection, context) => {
    if (inspection.valid !== (inspection.code === null))
      context.addIssue({
        code: 'custom',
        path: ['code'],
        message: 'inspection code must match validity'
      });
    uniqueProtocolIds(
      inspection.mcpServers.map((server2) => server2.id),
      context,
      ['mcpServers']
    );
  });
var conversationTemplateSummarySchema = external_exports
  .object({
    id: protocolIdSchema,
    nodeId: protocolIdSchema,
    name: external_exports.string().trim().min(1).max(128),
    description: external_exports.string().max(2e3),
    icon: external_exports.string().trim().min(1).max(128).optional(),
    status: conversationTemplateStatusSchema,
    currentVersionId: protocolIdSchema.nullable(),
    available: external_exports.boolean(),
    createdAt: external_exports.number().int().nonnegative(),
    updatedAt: external_exports.number().int().nonnegative()
  })
  .strict()
  .superRefine((template, context) => {
    if (template.available && (template.status !== 'ACTIVE' || template.currentVersionId === null))
      context.addIssue({
        code: 'custom',
        path: ['available'],
        message: 'available template requires an active published version'
      });
  });
var conversationTemplateVersionSchema = external_exports
  .object({
    id: protocolIdSchema,
    templateId: protocolIdSchema,
    version: external_exports.number().int().positive(),
    status: conversationTemplateVersionStatusSchema,
    contentHash: contentHashSchema,
    manifestHash: contentHashSchema,
    mcpConfigHash: contentHashSchema,
    fileCount: external_exports.number().int().nonnegative(),
    totalBytes: external_exports.number().int().nonnegative(),
    hostPolicyVersion: external_exports.number().int().positive(),
    publishedByUserId: external_exports.number().int().positive(),
    publishedAt: external_exports.number().int().nonnegative()
  })
  .strict();
var conversationTemplatePublishInputSchema = external_exports
  .object({
    templateId: protocolIdSchema,
    draftRevision: external_exports.number().int().positive(),
    requestId: protocolIdSchema
  })
  .strict();
var conversationTemplatePublishRequestSchema = external_exports
  .object({
    templateId: protocolIdSchema,
    jobId: protocolIdSchema,
    draft: conversationTemplateDraftSchema,
    requestedByUserId: external_exports.number().int().positive()
  })
  .strict()
  .superRefine((request, context) => {
    if (request.templateId !== request.draft.templateId)
      context.addIssue({
        code: 'custom',
        path: ['templateId'],
        message: 'publish template must match the draft'
      });
  });
var conversationTemplatePublishStatusInputSchema = external_exports
  .object({
    templateId: protocolIdSchema,
    jobId: protocolIdSchema
  })
  .strict();
var conversationTemplatePublishJobSchema = external_exports
  .object({
    id: protocolIdSchema,
    templateId: protocolIdSchema,
    draftRevision: external_exports.number().int().positive(),
    stage: external_exports.enum([
      'VALIDATING',
      'ENUMERATING',
      'COPYING',
      'SCANNING',
      'MANIFEST',
      'SEALED',
      'REGISTERED'
    ]),
    status: external_exports.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']),
    versionId: protocolIdSchema.optional(),
    errorCode: external_exports
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .nullable(),
    errorSummary: external_exports.string().max(1e3).optional(),
    createdAt: external_exports.number().int().nonnegative(),
    updatedAt: external_exports.number().int().nonnegative()
  })
  .strict()
  .superRefine((job, context) => {
    if (
      job.status === 'SUCCEEDED' &&
      (job.stage !== 'REGISTERED' || job.versionId === void 0 || job.errorCode !== null)
    )
      context.addIssue({ code: 'custom', message: 'successful publish job is incomplete' });
    if (job.status === 'FAILED' && job.errorCode === null)
      context.addIssue({ code: 'custom', message: 'failed publish job requires an error code' });
    if (job.status !== 'FAILED' && job.errorCode !== null)
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'only failed publish jobs may have an error code'
      });
  });
var conversationTemplatePublishResultSchema = external_exports
  .object({
    job: conversationTemplatePublishJobSchema,
    version: conversationTemplateVersionSchema.optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (result.job.status === 'SUCCEEDED') {
      if (
        result.version === void 0 ||
        result.version.id !== result.job.versionId ||
        result.version.templateId !== result.job.templateId ||
        result.version.status !== 'AVAILABLE'
      )
        context.addIssue({
          code: 'custom',
          path: ['version'],
          message: 'successful publish result requires its registered version'
        });
      return;
    }
    if (result.version !== void 0)
      context.addIssue({
        code: 'custom',
        path: ['version'],
        message: 'unfinished publish result cannot include a version'
      });
  });
var hostedConversationStatusSchema = external_exports.literal('ACTIVE');
var hostedConversationActivityStatusSchema = external_exports.enum([
  'STARTING',
  'RUNNING',
  'CANCELLING',
  'IDLE'
]);
var hostedConversationActivitySchema = external_exports
  .object({
    status: hostedConversationActivityStatusSchema,
    version: external_exports.number().int().nonnegative(),
    updatedAt: external_exports.number().int().nonnegative()
  })
  .strict();
var hostedConversationActivityProjectionSchema = external_exports
  .object({
    userId: external_exports.number().int().positive(),
    templateId: protocolIdSchema,
    conversationId: protocolIdSchema,
    activity: hostedConversationActivitySchema
  })
  .strict();
var hostedConversationActivityMessageSchema = external_exports
  .object({
    type: external_exports.literal('hosted-conversation.activity'),
    nodeId: protocolIdSchema,
    conversationId: protocolIdSchema,
    activity: hostedConversationActivitySchema
  })
  .strict();
var hostedConversationBaseObjectSchema = external_exports
  .object({
    id: protocolIdSchema,
    nodeId: protocolIdSchema,
    sessionId: protocolIdSchema,
    templateId: protocolIdSchema,
    templateName: external_exports.string().trim().min(1).max(128),
    activeVersionId: protocolIdSchema,
    title: external_exports.string().trim().min(1).max(160),
    titleSource: external_exports.enum(['DEFAULT', 'AUTO', 'CUSTOM']).default('CUSTOM'),
    pinnedAt: external_exports.number().int().nonnegative().nullable(),
    status: hostedConversationStatusSchema,
    modelId: protocolIdSchema,
    createdAt: external_exports.number().int().nonnegative(),
    updatedAt: external_exports.number().int().nonnegative(),
    lastActivityAt: external_exports.number().int().nonnegative()
  })
  .strict();
var hostedConversationSummarySchema = hostedConversationBaseObjectSchema
  .extend({
    activity: hostedConversationActivitySchema.default({
      status: 'IDLE',
      version: 0,
      updatedAt: 0
    })
  })
  .strict();
var hostedConversationManifestSchema = hostedConversationBaseObjectSchema
  .extend({
    userStorageKey: stableStorageKeySchema,
    conversationStorageKey: stableStorageKeySchema,
    clientRequestId: protocolIdSchema.optional(),
    templateDeleted: external_exports.boolean(),
    quota: external_exports
      .object({
        usedBytes: external_exports.number().int().nonnegative(),
        maxBytes: external_exports.number().int().positive()
      })
      .strict()
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.quota.usedBytes > manifest.quota.maxBytes)
      context.addIssue({ code: 'custom', path: ['quota'], message: 'quota is exceeded' });
  });
var conversationFileProjectionSchema = external_exports
  .object({
    id: protocolIdSchema,
    conversationId: protocolIdSchema,
    category: external_exports.enum(['UPLOAD', 'OUTPUT']),
    relativePath: conversationRelativePathSchema,
    displayName: external_exports.string().trim().min(1).max(512),
    mimeType: external_exports.string().trim().min(1).max(255),
    size: external_exports.number().int().nonnegative(),
    source: external_exports.enum(['USER', 'AGENT', 'SYSTEM']),
    turnId: protocolIdSchema.optional(),
    itemId: protocolIdSchema.optional(),
    createdAt: external_exports.number().int().nonnegative(),
    updatedAt: external_exports.number().int().nonnegative()
  })
  .strict();
var hostedConversationSnapshotSchema = external_exports
  .object({
    nodeAppVersion: external_exports.string().trim().min(1).max(128).optional(),
    conversation: hostedConversationSummarySchema,
    template: conversationTemplateSummarySchema,
    run: external_exports
      .object({
        id: protocolIdSchema,
        status: agentRunStatusSchema,
        startedAt: external_exports.number().int().nonnegative().nullable(),
        completedAt: external_exports.number().int().nonnegative().nullable()
      })
      .strict()
      .nullable(),
    turns: external_exports.array(conversationTurnSchema),
    historyNextCursor: external_exports.string().min(1).max(2048).nullable(),
    historyVersion: external_exports.string().min(1).max(160).optional(),
    files: external_exports.array(conversationFileProjectionSchema),
    models: external_exports.array(marAgentNodeModelSummarySchema),
    error: external_exports
      .object({
        code: external_exports.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
        message: external_exports.string().min(1).max(1e3)
      })
      .strict()
      .nullable(),
    snapshotSequence: external_exports.number().int().nonnegative()
  })
  .strict()
  .superRefine((snapshot, context) => {
    uniqueProtocolIds(
      snapshot.models.map((model) => model.id),
      context,
      ['models']
    );
  });
var hostedConversationCreateInputSchema = external_exports
  .object({
    templateId: protocolIdSchema,
    clientRequestId: protocolIdSchema,
    modelId: protocolIdSchema.optional()
  })
  .strict();
var hostedConversationModelOptionsInputSchema = external_exports
  .object({ templateId: protocolIdSchema })
  .strict();
var hostedConversationModelOptionsSchema = external_exports
  .object({
    models: external_exports.array(marAgentNodeModelSummarySchema),
    defaultModelId: protocolIdSchema.nullable()
  })
  .strict()
  .superRefine((options, context) => {
    uniqueProtocolIds(
      options.models.map((model) => model.id),
      context,
      ['models']
    );
    if (options.models.length === 0 && options.defaultModelId !== null)
      context.addIssue({ code: 'custom', path: ['defaultModelId'] });
    if (
      options.models.length > 0 &&
      (options.defaultModelId === null ||
        !options.models.some((model) => model.id === options.defaultModelId))
    )
      context.addIssue({ code: 'custom', path: ['defaultModelId'] });
  });
var hostedConversationListInputSchema = external_exports
  .object({
    limit: external_exports.number().int().min(1).max(100).default(20),
    cursor: external_exports.string().min(1).max(2048).optional()
  })
  .strict();
var hostedConversationListPageSchema = external_exports
  .object({
    items: external_exports.array(hostedConversationSummarySchema).max(100),
    nextCursor: external_exports.string().min(1).max(2048).nullable()
  })
  .strict();
var hostedConversationDirectoryPageSchema = external_exports
  .object({
    items: external_exports.array(hostedConversationSummarySchema),
    nextCursor: external_exports.string().min(1).max(2048).nullable()
  })
  .strict();
var hostedConversationIdInputSchema = external_exports
  .object({
    conversationId: protocolIdSchema
  })
  .strict();
var hostedConversationHistoryInputSchema = hostedConversationIdInputSchema
  .extend({
    limit: external_exports.number().int().min(1).max(100).default(10),
    cursor: external_exports.string().min(1).max(2048).optional()
  })
  .strict();
var hostedConversationHistoryPageSchema = external_exports
  .object({
    turns: external_exports.array(conversationTurnSchema).max(100),
    nextCursor: external_exports.string().min(1).max(2048).nullable()
  })
  .strict();
var hostedConversationRollbackInputSchema = hostedConversationIdInputSchema
  .extend({
    turnId: external_exports.string().min(1).max(128),
    itemId: external_exports.string().min(1).max(128).optional(),
    boundary: external_exports.string().min(1).max(256).nullable()
  })
  .strict();
var imagePreviewOptionsSchema = external_exports
  .object({
    maxWidth: external_exports.number().int().min(1).max(4096),
    maxHeight: external_exports.number().int().min(1).max(4096)
  })
  .strict();
var runImageReadInputSchema = external_exports.union([
  external_exports
    .object({
      runId: protocolIdSchema,
      imageIndex: external_exports.number().int().nonnegative(),
      preview: imagePreviewOptionsSchema.optional()
    })
    .strict(),
  external_exports
    .object({
      runId: protocolIdSchema,
      imageRef: imageRefSchema,
      preview: imagePreviewOptionsSchema.optional()
    })
    .strict()
]);
var modelResourceInputSchema = external_exports.object({
  sessionId: protocolIdSchema,
  resourceId: external_exports.string().regex(/^[a-f0-9]{64}$/u),
  expiresAt: external_exports.number().int().positive().safe(),
  signature: external_exports.string().regex(/^[A-Za-z0-9_-]{43}$/u)
});
var modelResourceReadInputSchema = external_exports.union([
  modelResourceInputSchema.extend({ workspaceId: protocolIdSchema }).strict(),
  modelResourceInputSchema.extend({ conversationId: protocolIdSchema }).strict()
]);
var hostedConversationImageReadInputSchema = hostedConversationIdInputSchema
  .extend({
    runId: protocolIdSchema,
    imageRef: imageRefSchema,
    preview: imagePreviewOptionsSchema.optional()
  })
  .strict();
var hostedConversationDeleteResultSchema = external_exports
  .object({
    deletedConversationId: protocolIdSchema
  })
  .strict();
var hostedConversationMessageInputSchema = external_exports
  .object({
    conversationId: protocolIdSchema,
    clientMessageId: protocolIdSchema,
    prompt: external_exports.string().max(1e5),
    attachmentIds: external_exports.array(protocolIdSchema).max(32).default([]),
    modelId: protocolIdSchema.optional(),
    deliveryIntent: external_exports.literal('REPLACE_CURRENT').optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.prompt.trim().length === 0 && input.attachmentIds.length === 0)
      context.addIssue({ code: 'custom', message: 'message requires text or attachments' });
    uniqueProtocolIds(input.attachmentIds, context, ['attachmentIds']);
  });
var hostedConversationConfigUpdateInputSchema = external_exports
  .object({
    conversationId: protocolIdSchema,
    modelId: protocolIdSchema
  })
  .strict();
var hostedConversationTemplateSwitchInputSchema = external_exports
  .object({
    conversationId: protocolIdSchema,
    templateId: protocolIdSchema,
    expectedTemplateId: protocolIdSchema
  })
  .strict();
var hostedConversationTemplateSwitchResultSchema = external_exports
  .object({
    conversation: hostedConversationSummarySchema,
    template: conversationTemplateSummarySchema,
    models: external_exports.array(marAgentNodeModelSummarySchema)
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.conversation.templateId !== value.template.id ||
      value.conversation.nodeId !== value.template.nodeId ||
      value.conversation.activeVersionId !== value.template.currentVersionId
    )
      context.addIssue({ code: 'custom', message: 'Inconsistent conversation template binding' });
  });
var hostedConversationMetadataUpdateInputSchema = external_exports
  .object({
    conversationId: protocolIdSchema,
    title: external_exports.string().trim().min(1).max(160).optional(),
    pinned: external_exports.boolean().optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.title === void 0 && input.pinned === void 0)
      context.addIssue({ code: 'custom', message: 'metadata update requires a change' });
  });
var hostedConversationWatchInputSchema = external_exports
  .object({
    conversationId: protocolIdSchema,
    mode: external_exports.enum(['initial', 'renew']),
    workbenchConnectionId: external_exports.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    watchId: external_exports.string().regex(/^[A-Za-z0-9_-]{8,128}$/)
  })
  .strict();
var hostedConversationUnwatchInputSchema = external_exports
  .object({
    conversationId: protocolIdSchema,
    workbenchConnectionId: external_exports.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    watchId: external_exports.string().regex(/^[A-Za-z0-9_-]{8,128}$/)
  })
  .strict();
var hostedConversationUploadFileSchema = external_exports
  .object({
    name: external_exports
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine(
        (name2) =>
          name2 !== '.' &&
          name2 !== '..' &&
          !name2.includes('/') &&
          !name2.includes('\\') &&
          !name2.includes('\0'),
        'upload name is invalid'
      ),
    size: external_exports.number().int().nonnegative(),
    mimeType: external_exports.string().trim().min(1).max(255)
  })
  .strict();
var hostedConversationFilesSchema = external_exports
  .object({
    files: external_exports.array(conversationFileProjectionSchema)
  })
  .strict();
var hostedConversationFileReadInputSchema = hostedConversationIdInputSchema
  .extend({
    fileId: protocolIdSchema,
    preview: imagePreviewOptionsSchema.optional(),
    offset: external_exports.number().int().nonnegative().optional(),
    limit: external_exports
      .number()
      .int()
      .min(1)
      .max(512 * 1024)
      .optional()
  })
  .strict();
var hostedConversationFileDeleteInputSchema = hostedConversationIdInputSchema
  .extend({
    fileId: protocolIdSchema
  })
  .strict();
var hostedConversationFileDeleteResultSchema = external_exports
  .object({
    deletedFileId: protocolIdSchema,
    files: external_exports.array(conversationFileProjectionSchema)
  })
  .strict()
  .superRefine((result, context) => {
    uniqueProtocolIds(
      result.files.map((file) => file.id),
      context,
      ['files']
    );
    if (result.files.some((file) => file.id === result.deletedFileId))
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'deleted file cannot remain projected'
      });
  });
var hostedConversationFileReadResultSchema = external_exports
  .object({
    file: conversationFileProjectionSchema,
    encoding: external_exports.literal('base64'),
    content: external_exports.string().max(Math.ceil((512 * 1024 * 4) / 3) + 4),
    offset: external_exports.number().int().nonnegative(),
    nextOffset: external_exports.number().int().nonnegative().nullable(),
    eof: external_exports.boolean()
  })
  .strict()
  .superRefine((result, context) => {
    if (!canonicalBase64(result.content))
      context.addIssue({ code: 'custom', path: ['content'], message: 'file content is invalid' });
    if (result.nextOffset !== null && result.nextOffset <= result.offset)
      context.addIssue({
        code: 'custom',
        path: ['nextOffset'],
        message: 'next offset must advance'
      });
  });
var hostedConversationUploadPreflightInputSchema = hostedConversationIdInputSchema
  .extend({
    files: external_exports.array(hostedConversationUploadFileSchema).min(1).max(32)
  })
  .strict();
var hostedConversationUploadPreflightResultSchema = external_exports
  .object({
    files: external_exports.array(
      external_exports
        .object({
          name: hostedConversationUploadFileSchema.shape.name,
          status: external_exports.enum([
            'READY',
            'INVALID_NAME',
            'TOO_LARGE',
            'QUOTA_EXCEEDED',
            'CONFLICT'
          ])
        })
        .strict()
    )
  })
  .strict();
var hostedConversationUploadCreateInputSchema = hostedConversationUploadFileSchema
  .extend({
    conversationId: protocolIdSchema,
    clientRequestId: protocolIdSchema
  })
  .strict();
var hostedConversationUploadChunkInputSchema = hostedConversationIdInputSchema
  .extend({
    uploadId: protocolIdSchema,
    offset: external_exports.number().int().nonnegative(),
    dataBase64: external_exports
      .string()
      .min(4)
      .max(Math.ceil((512 * 1024 * 4) / 3) + 4)
      .refine(
        (value) => canonicalBase64(value) && base64DecodedByteLength(value) <= 512 * 1024,
        'upload chunk is invalid'
      )
  })
  .strict();
var hostedConversationUploadControlInputSchema = hostedConversationIdInputSchema
  .extend({
    uploadId: protocolIdSchema
  })
  .strict();
var hostedConversationUploadSchema = external_exports
  .object({
    uploadId: protocolIdSchema,
    conversationId: protocolIdSchema,
    name: hostedConversationUploadFileSchema.shape.name,
    mimeType: hostedConversationUploadFileSchema.shape.mimeType,
    receivedBytes: external_exports.number().int().nonnegative(),
    size: external_exports.number().int().nonnegative(),
    status: external_exports.enum(['UPLOADING', 'COMPLETED', 'CANCELLED']),
    file: conversationFileProjectionSchema.optional()
  })
  .strict()
  .superRefine((upload, context) => {
    if (upload.receivedBytes > upload.size)
      context.addIssue({
        code: 'custom',
        path: ['receivedBytes'],
        message: 'received bytes exceed upload size'
      });
    if (upload.status === 'COMPLETED' && upload.file === void 0)
      context.addIssue({
        code: 'custom',
        path: ['file'],
        message: 'completed upload requires a file'
      });
    if (upload.status !== 'COMPLETED' && upload.file !== void 0)
      context.addIssue({
        code: 'custom',
        path: ['file'],
        message: 'unfinished upload cannot include a file'
      });
  });
var conversationSegmentSchema = external_exports.object({
  id: external_exports.string().min(1).max(256),
  sessionId: external_exports.string().min(1).max(128),
  turnId: external_exports.string().min(1).max(128),
  runId: external_exports.string().min(1).max(128).nullable(),
  index: external_exports.number().int().nonnegative(),
  status: conversationTurnSchema.shape.status,
  rewind: conversationTurnSchema.shape.rewind,
  items: external_exports.array(conversationItemSchema),
  startedAt: external_exports.number().int().nonnegative().nullable(),
  completedAt: external_exports.number().int().nonnegative().nullable()
});
var conversationSegmentPageSchema = external_exports.object({
  unit: external_exports.literal('SEGMENT'),
  segments: external_exports.array(conversationSegmentSchema),
  nextCursor: external_exports.string().max(4096).nullable(),
  snapshotSequence: external_exports.number().int().nonnegative(),
  source: external_exports.enum(['official', 'native', 'runtime']),
  readAt: external_exports.number().int().nonnegative(),
  latestVisibleAt: external_exports.number().int().nonnegative(),
  deferredOlderHistory: external_exports.boolean().optional()
});
var conversationItemDeltaSchema = external_exports.discriminatedUnion('kind', [
  external_exports.object({
    kind: external_exports.literal('assistant_text_append'),
    itemId: external_exports.string().min(1).max(128),
    itemRevision: external_exports.number().int().nonnegative(),
    text: external_exports.string()
  }),
  external_exports.object({
    kind: external_exports.literal('plan_replace'),
    itemId: external_exports.string().min(1).max(128),
    itemRevision: external_exports.number().int().nonnegative(),
    steps: external_exports.array(
      external_exports.object({
        id: external_exports.string(),
        text: external_exports.string(),
        status: external_exports.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED'])
      })
    )
  }),
  external_exports.object({
    kind: external_exports.literal('tool_progress_replace'),
    itemId: external_exports.string().min(1).max(128),
    itemRevision: external_exports.number().int().nonnegative(),
    label: external_exports.string().max(500)
  })
]);
var terminalDataFrameSchema = external_exports.discriminatedUnion('type', [
  external_exports.object({
    type: external_exports.literal('attach'),
    terminalId: external_exports.string().min(1).max(128),
    afterSequence: external_exports.number().int().nonnegative()
  }),
  external_exports.object({
    type: external_exports.literal('resize'),
    terminalId: external_exports.string().min(1).max(128),
    rows: external_exports.number().int().positive().max(1e3),
    cols: external_exports.number().int().positive().max(1e3)
  }),
  external_exports.object({
    type: external_exports.literal('input'),
    terminalId: external_exports.string().min(1).max(128),
    data: external_exports.string().max(65536)
  }),
  external_exports.object({
    type: external_exports.literal('output'),
    terminalId: external_exports.string().min(1).max(128),
    sequence: external_exports.number().int().positive(),
    data: external_exports.string().max(65536)
  }),
  external_exports.object({
    type: external_exports.literal('close'),
    terminalId: external_exports.string().min(1).max(128)
  }),
  external_exports.object({
    type: external_exports.literal('exit'),
    terminalId: external_exports.string().min(1).max(128),
    exitCode: external_exports.number().int().nullable()
  }),
  external_exports.object({
    type: external_exports.literal('error'),
    terminalId: external_exports.string().min(1).max(128),
    code: external_exports.string().min(1).max(80)
  })
]);
var terminalAttachTicketSchema = external_exports
  .object({
    ticket: external_exports.string().min(32).max(512),
    nodeId: external_exports.string().min(1).max(128),
    terminalId: external_exports.string().min(1).max(128),
    userSessionFingerprint: external_exports.string().min(1).max(128),
    issuedAt: external_exports.number().int().nonnegative(),
    expiresAt: external_exports.number().int().positive()
  })
  .superRefine((value, context) => {
    if (value.expiresAt <= value.issuedAt) {
      context.addIssue({ code: 'custom', message: 'terminal ticket expiry must follow issuance' });
    }
  });
var workspaceFileEntrySchema = external_exports.object({
  path: external_exports.string().min(1).max(4096),
  name: external_exports.string().min(1).max(512),
  kind: external_exports.enum(['FILE', 'DIRECTORY']),
  size: external_exports.number().int().nonnegative().nullable(),
  modifiedAt: external_exports.number().int().nonnegative().nullable(),
  score: external_exports.number().min(0).max(256e3).optional()
});
var workspaceFileListSchema = external_exports.object({
  entries: external_exports.array(workspaceFileEntrySchema),
  nextCursor: external_exports.string().min(1).max(1024).nullable(),
  truncated: external_exports.boolean(),
  indexState: external_exports.enum(['BUILDING', 'READY']).optional()
});
var workspaceContentMatchSchema = external_exports.object({
  path: external_exports.string().min(1).max(4096),
  line: external_exports.number().int().positive(),
  column: external_exports.number().int().positive(),
  preview: external_exports.string().max(8192)
});
var workspaceContentSearchSchema = external_exports.object({
  matches: external_exports.array(workspaceContentMatchSchema).max(200),
  engine: external_exports.enum(['RIPGREP', 'GREP', 'POWERSHELL', 'NODE']),
  truncated: external_exports.boolean(),
  skippedFiles: external_exports.number().int().nonnegative()
});
var workspaceFileReferenceSourceContextSchema = external_exports
  .object({
    text: external_exports
      .string()
      .min(1)
      .refine((value) => utf8ByteLength(value) <= 8 * 1024),
    position: external_exports.number().int().nonnegative()
  })
  .strict();
var workspaceFileReferenceSchema = external_exports
  .object({
    languageId: external_exports.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    extractorId: external_exports.string().regex(/^[a-z][a-z0-9.-]{0,127}$/u),
    kind: external_exports.enum(['relative-file', 'module', 'namespace', 'include']),
    anchor: external_exports.string().min(1).max(1024).optional(),
    value: external_exports.string().min(1).max(1024),
    from: external_exports
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024),
    to: external_exports
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    sourceContext: workspaceFileReferenceSourceContextSchema
  })
  .strict()
  .refine((reference) => reference.to > reference.from);
var workspaceSymbolDefinitionTargetSchema = external_exports.object({
  path: external_exports.string().min(1).max(4096),
  line: external_exports.number().int().positive(),
  kind: external_exports.string().min(1).max(128).optional(),
  scope: external_exports.string().min(1).max(1024).optional(),
  preview: external_exports.string().min(1).max(512).optional()
});
var workspaceSymbolReferenceSchema = external_exports.object({
  path: external_exports.string().min(1).max(4096),
  line: external_exports.number().int().positive(),
  column: external_exports.number().int().positive(),
  preview: external_exports.string().min(1).max(8192)
});
var workspaceSymbolDefinitionSchema = external_exports.object({
  state: external_exports.enum(['UNAVAILABLE', 'BUILDING', 'READY', 'STALE', 'FAILED']),
  targets: external_exports.array(workspaceSymbolDefinitionTargetSchema).max(20),
  references: external_exports.array(workspaceSymbolReferenceSchema).max(100).default([]),
  referenceTruncated: external_exports.boolean().default(false),
  paths: external_exports.array(workspaceSymbolDefinitionTargetSchema).max(20).default([]),
  truncated: external_exports.boolean(),
  failureCode: external_exports
    .enum(['SYMBOL_INDEX_BUILD_FAILED', 'SYMBOL_INDEX_LIMIT_EXCEEDED'])
    .optional()
});
var workspaceSymbolIndexPreparationSchema = external_exports
  .object({
    state: external_exports.enum(['UNAVAILABLE', 'BUILDING', 'READY', 'STALE', 'FAILED']),
    failureCode: external_exports
      .enum(['SYMBOL_INDEX_BUILD_FAILED', 'SYMBOL_INDEX_LIMIT_EXCEEDED'])
      .optional()
  })
  .strict();
var workspaceFileReadSchema = external_exports.object({
  path: external_exports.string().min(1).max(4096),
  encoding: external_exports.enum(['utf-8', 'base64']),
  size: external_exports.number().int().nonnegative(),
  content: external_exports.string(),
  truncated: external_exports.boolean(),
  nextOffset: external_exports.number().int().nonnegative().nullable()
});
var workspaceUploadPreflightSchema = external_exports.object({
  name: external_exports.string().min(1).max(512),
  status: external_exports.enum(['READY', 'EXISTS_FILE', 'EXISTS_DIRECTORY', 'INVALID_NAME']),
  path: external_exports.string().min(1).max(4096).nullable()
});
var workspaceUploadSchema = external_exports.object({
  uploadId: external_exports.string().uuid(),
  path: external_exports.string().min(1).max(4096),
  receivedBytes: external_exports.number().int().nonnegative(),
  size: external_exports.number().int().nonnegative()
});
var workspaceChangeSchema = external_exports.object({
  path: external_exports.string().min(1).max(4096),
  state: external_exports.enum(['STAGED', 'UNSTAGED', 'UNTRACKED']),
  change: external_exports.enum([
    'ADDED',
    'MODIFIED',
    'DELETED',
    'RENAMED',
    'COPIED',
    'TYPE_CHANGED'
  ]),
  additions: external_exports.number().int().nonnegative().nullable(),
  deletions: external_exports.number().int().nonnegative().nullable(),
  binary: external_exports.boolean(),
  diffAvailable: external_exports.boolean()
});
var workspaceGitWorktreeSummarySchema = external_exports
  .object({
    directoryName: external_exports.string().trim().min(1).max(512),
    branch: external_exports.string().min(1).max(512).nullable(),
    head: external_exports.string().regex(/^[0-9a-f]{40,64}$/),
    current: external_exports.boolean(),
    status: external_exports.enum(['CLEAN', 'DIRTY', 'UNAVAILABLE']),
    locked: external_exports.boolean(),
    prunable: external_exports.boolean()
  })
  .strict();
var workspaceGitTrackingSchema = external_exports.object({
  upstream: external_exports.string().min(1).max(512),
  ahead: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  behind: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
});
var workspaceChangesRepositorySchema = external_exports
  .object({
    repositoryPath: external_exports.string().max(4096),
    repositoryName: external_exports.string().min(1).max(512),
    source: external_exports.enum(['ROOT', 'SUBMODULE', 'WORKTREE']),
    worktreePath: external_exports.string().min(1).max(4096).optional(),
    physicalPath: external_exports.string().min(1).max(4096).optional(),
    current: external_exports.boolean().optional(),
    branch: external_exports.string().max(512).nullable(),
    tracking: workspaceGitTrackingSchema.optional(),
    head: external_exports
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .optional(),
    status: external_exports.enum(['CLEAN', 'DIRTY', 'UNAVAILABLE']).optional(),
    locked: external_exports.boolean().optional(),
    prunable: external_exports.boolean().optional(),
    error: external_exports.lazy(() => publicErrorSchema).optional(),
    changesTruncated: external_exports.boolean().optional(),
    changes: external_exports.array(workspaceChangeSchema)
  })
  .superRefine((repository, context) => {
    if (repository.source === 'SUBMODULE') {
      if (repository.repositoryPath.length === 0 || repository.worktreePath !== void 0)
        context.addIssue({ code: 'custom', message: 'Invalid submodule repository target' });
      return;
    }
    if (
      repository.repositoryPath.length !== 0 ||
      repository.physicalPath === void 0 ||
      repository.current === void 0 ||
      repository.status === void 0 ||
      repository.locked === void 0 ||
      repository.prunable === void 0
    )
      context.addIssue({ code: 'custom', message: 'Incomplete worktree repository metadata' });
    if (repository.source === 'ROOT') {
      if (repository.worktreePath !== void 0 || repository.current !== true)
        context.addIssue({ code: 'custom', message: 'Invalid root repository target' });
      return;
    }
    if (
      repository.worktreePath === void 0 ||
      repository.current !== false ||
      repository.head === void 0
    )
      context.addIssue({ code: 'custom', message: 'Invalid linked worktree repository target' });
  });
var workspaceChangesSummarySchema = external_exports.object({
  branch: external_exports.string().max(512).nullable(),
  changes: external_exports.array(workspaceChangeSchema),
  repositories: external_exports.array(workspaceChangesRepositorySchema),
  worktrees: external_exports.array(workspaceGitWorktreeSummarySchema).max(128).optional(),
  worktreesTruncated: external_exports.boolean().optional(),
  partial: external_exports.boolean().optional(),
  errors: external_exports
    .array(external_exports.lazy(() => publicErrorSchema))
    .max(16)
    .optional()
});
var gitHistoryRefSchema = external_exports.object({
  name: external_exports.string().min(1).max(512),
  displayName: external_exports.string().min(1).max(512),
  kind: external_exports.enum(['LOCAL', 'REMOTE']),
  hash: external_exports.string().regex(/^[0-9a-f]{40,64}$/),
  current: external_exports.boolean()
});
var gitHistoryCommitSchema = external_exports.object({
  hash: external_exports.string().regex(/^[0-9a-f]{40,64}$/),
  parents: external_exports.array(external_exports.string().regex(/^[0-9a-f]{40,64}$/)),
  subject: external_exports.string().max(4096),
  authorName: external_exports.string().max(512),
  authorEmail: external_exports.string().max(512),
  committedAt: external_exports.number().int().nonnegative(),
  refs: external_exports.array(external_exports.string().min(1).max(512))
});
var gitHistoryFileSchema = external_exports.object({
  path: external_exports.string().min(1).max(4096),
  previousPath: external_exports.string().min(1).max(4096).optional(),
  change: external_exports.enum([
    'ADDED',
    'MODIFIED',
    'DELETED',
    'RENAMED',
    'COPIED',
    'TYPE_CHANGED'
  ])
});
var workbenchNodeOperationSchema = external_exports.enum([
  'agent.network',
  'workspace.git.settings.get',
  'workspace.git.settings.update',
  'node.workbench.capabilities',
  'runner.usage.status',
  'runner.usage.read',
  'workspace.directories.list',
  'workspace.remove',
  'workspace.watch',
  'workspace.unwatch',
  'session.unwatch',
  'session.metadata.update',
  'session.schedule.get',
  'session.schedule.list',
  'session.schedule.agent.save',
  'session.cli.context',
  'session.graph',
  'session.goal.get',
  'session.schedule.save',
  'session.schedule.remove',
  'session.schedule.proposal.resolve',
  'session.pin.move',
  'session.rewind',
  'session.rollback',
  'session.remove',
  'workspace.sessions.cleanup',
  'session.config.update',
  'session.turns.list',
  'session.events.read',
  'session.context.read',
  'session.tool-resource.read',
  'session.command.execute',
  'runner.command.execute',
  'runner.profiles.list',
  'runner.defaults.save',
  'mar-agent.model.test',
  'prompt-completion.context',
  'prompt-completion.generate',
  'prompt-completion.cancel',
  'workspace.files.list',
  'workspace.file.read',
  'workspace.file.write',
  'workspace.file.content.read',
  'workspace.file.direct.metadata',
  'workspace.files.search',
  'workspace.files.mutate',
  'workspace.files.reveal',
  'workspace.content.search',
  'workspace.symbol.prepare',
  'workspace.symbol.definition',
  'workspace.files.upload.preflight',
  'workspace.files.upload.create',
  'workspace.files.upload.chunk',
  'workspace.files.upload.status',
  'workspace.files.upload.complete',
  'workspace.files.upload.cancel',
  'workspace.changes.current',
  'workspace.change.diff',
  'workspace.change.restore',
  'workspace.git.fetch',
  'workspace.git.refs.list',
  'workspace.git.history.list',
  'workspace.git.commit.files',
  'workspace.git.commit.file.diff',
  'workspace.git.commit.file.content.read',
  'workspace.git.commit.file.direct.metadata',
  'run.image.read',
  'model.resource.read',
  'terminal.open',
  'terminal.command.open',
  'terminal.list',
  'terminal.close',
  'terminal.attach.authorize',
  'terminal.direct.preflight',
  'desktop.describe',
  'node.upgrade.request',
  'node.upgrade.cancel',
  'node.skills.inspect',
  'node.skills.install',
  'node.skills.remove',
  'workspace.skills.inspect',
  'workspace.skills.install',
  'workspace.skills.remove',
  'workspace.skills.git-exclude-repair',
  'skill.install.job.get',
  'node.mcps.inspect',
  'node.mcps.install',
  'node.mcps.remove',
  'workspace.mcps.inspect',
  'workspace.mcps.install',
  'workspace.mcps.remove',
  'conversation.template.source.inspect',
  'conversation.template.publish',
  'conversation.template.publish.status',
  'conversation.template.version.inspect',
  'conversation.hosting.enable',
  'conversation.hosting.disable',
  'conversation.hosting.storage.inspect',
  'conversation.hosting.cleanup.preview',
  'conversation.hosting.cleanup.execute',
  'computer.use.enable',
  'computer.use.disable',
  'conversation.hosted.list',
  'conversation.hosted.model-options',
  'conversation.hosted.create',
  'conversation.hosted.get',
  'conversation.hosted.history',
  'conversation.hosted.watch',
  'conversation.hosted.unwatch',
  'conversation.hosted.message',
  'conversation.hosted.rollback',
  'conversation.hosted.interrupt',
  'conversation.hosted.config.update',
  'conversation.hosted.template.switch',
  'conversation.hosted.metadata.update',
  'conversation.hosted.image.read',
  'conversation.hosted.tool-resource.read',
  'conversation.hosted.files.list',
  'conversation.hosted.file.read',
  'conversation.hosted.file.delete',
  'conversation.hosted.files.upload.preflight',
  'conversation.hosted.files.upload.create',
  'conversation.hosted.files.upload.chunk',
  'conversation.hosted.files.upload.status',
  'conversation.hosted.files.upload.complete',
  'conversation.hosted.files.upload.cancel',
  'conversation.hosted.delete'
]);
var nodeEnvelopeSchema = external_exports.object({
  version: external_exports.literal(NODE_PROTOCOL_VERSION),
  id: external_exports.string().min(1).max(128),
  type: external_exports.string().min(1).max(80),
  replyTo: external_exports.string().min(1).max(128).optional(),
  payload: external_exports.unknown()
});
var PUBLIC_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;
var publicErrorTextSchema = external_exports.string().trim().min(1).max(1e3);
var publicErrorParameterKeySchema = external_exports.string().trim().min(1).max(128);
var publicErrorParametersSchema = external_exports
  .record(
    publicErrorParameterKeySchema,
    external_exports.union([external_exports.string().max(1e3), external_exports.number().finite()])
  )
  .superRefine((parameters, context) => {
    if (Object.keys(parameters).length > 32)
      context.addIssue({ code: 'custom', message: 'too many public error parameters' });
  });
var publicErrorSchema = external_exports
  .object({
    code: external_exports.string().regex(PUBLIC_ERROR_CODE),
    message: publicErrorTextSchema,
    details: publicErrorTextSchema.optional(),
    parameters: publicErrorParametersSchema.optional()
  })
  .strict();
var nodeResponseErrorPayloadSchema = external_exports
  .object({
    error: external_exports.string().regex(PUBLIC_ERROR_CODE),
    message: publicErrorTextSchema,
    details: publicErrorTextSchema.optional(),
    parameters: publicErrorParametersSchema.optional()
  })
  .strict();
var httpErrorResponseSchema = external_exports
  .object({
    error: publicErrorSchema
      .extend({
        requestId: external_exports.string().min(1).max(128),
        upstreamRequestId: external_exports.string().min(1).max(128).optional()
      })
      .strict()
  })
  .strict();
var nodeErrorSchema = external_exports.object({
  code: external_exports.enum([
    'PROTOCOL_VERSION_UNSUPPORTED',
    'MESSAGE_TYPE_UNKNOWN',
    'MESSAGE_INVALID',
    'NODE_UNAUTHENTICATED',
    'NODE_DISABLED',
    'REGISTRATION_TOKEN_INVALID',
    'WORKSPACE_INVALID',
    'RUN_NOT_FOUND',
    'RUN_STATE_INVALID',
    'RUN_LOST',
    'APPROVAL_NOT_FOUND',
    'APPROVAL_EXPIRED',
    'APPROVAL_ALREADY_DECIDED',
    'APPROVAL_ALREADY_EXISTS',
    'WORKBENCH_PROTOCOL_UNSUPPORTED',
    'CAPABILITY_UNAVAILABLE',
    'CAPABILITY_VERSION_UNSUPPORTED',
    'CAPABILITY_STALE',
    'EVENT_CURSOR_INVALID',
    'EVENT_CURSOR_GAP',
    'ITEM_REVISION_CONFLICT',
    'RUNNER_PROFILE_INVALID',
    'RUNNER_COMMAND_UNSUPPORTED',
    'FILE_NOT_FOUND',
    'FILE_NOT_REGULAR',
    'FILE_TOO_LARGE',
    'FILE_ENCODING_UNSUPPORTED',
    'FILE_PATH_ESCAPE',
    'FILE_REVEAL_INVALID',
    'FILE_MANAGER_UNAVAILABLE',
    'DIRECTORY_CURSOR_INVALID',
    'FILE_SEARCH_LIMIT_EXCEEDED',
    'GIT_CHANGE_RESTORE_UNAVAILABLE',
    'TERMINAL_UNAVAILABLE',
    'TERMINAL_LIMIT_REACHED',
    'TERMINAL_NOT_FOUND',
    'TERMINAL_ATTACH_CONFLICT',
    'TERMINAL_REPLAY_GAP',
    'TERMINAL_DATA_CHANNEL_UNAVAILABLE',
    'SKILL_TARGET_OFFLINE',
    'SKILL_TARGET_LIMIT_EXCEEDED',
    'SKILL_NAME_CONFLICT',
    'SKILL_PATH_UNSAFE',
    'SKILL_CONTENT_INVALID',
    'SKILL_INSTALL_PARTIAL',
    'SKILL_INSTALL_FAILED',
    'SKILL_INSTALL_VERSION_UNKNOWN',
    'SKILL_INSTALL_RECOVERY_REQUIRED',
    'SKILL_INSTALL_INVALID_LINK',
    'NODE_SKILL_LINK_UNAVAILABLE',
    'WORKSPACE_SKILL_GIT_EXCLUDE_FAILED',
    'WORKSPACE_SKILL_TRACKED_CONFIRM_REQUIRED',
    'CONVERSATION_HOSTING_UNAVAILABLE',
    'CONVERSATION_HOSTING_STORAGE_FULL',
    'CONVERSATION_TEMPLATE_NOT_FOUND',
    'CONVERSATION_TEMPLATE_NOT_AUTHORIZED',
    'CONVERSATION_TEMPLATE_NOT_PUBLISHED',
    'CONVERSATION_TEMPLATE_REVISION_CONFLICT',
    'CONVERSATION_TEMPLATE_VERSION_CORRUPTED',
    'HOSTED_CONVERSATION_NOT_FOUND',
    'HOSTED_CONVERSATION_NOT_AUTHORIZED',
    'HOSTED_CONVERSATION_UPGRADE_FAILED',
    'HOSTED_CONVERSATION_QUOTA_EXCEEDED',
    'HOSTED_CONVERSATION_TEMPLATE_CONFLICT',
    'HOSTED_CONVERSATION_FILE_INVALID',
    'HOSTED_CONVERSATION_FILE_NOT_FOUND',
    'HOSTED_CONVERSATION_FILE_CONFLICT',
    'SANDBOX_UNAVAILABLE',
    'SANDBOX_POLICY_INVALID',
    'SANDBOX_RESOURCE_LIMIT',
    'INTERNAL_ERROR'
  ])
});

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
  constructor(code3) {
    super(messages[code3]);
    this.code = code3;
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
      const count2 = Math.min(data.byteLength - offset, this.#buffer.length - this.#end);
      if (count2 === 0) {
        this.#fail('DESKTOP_RFB_INVALID');
        return;
      }
      this.#buffer.set(data.subarray(offset, offset + count2), this.#end);
      this.#end += count2;
      offset += count2;
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
        const count2 = this.#buffer.readUInt16BE(this.#begin + 2);
        if (count2 > _RfbClientGate.maxEncodings) {
          this.#fail('DESKTOP_RFB_INVALID');
          return void 0;
        }
        return 4 + count2 * 4;
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
  #fail(code3) {
    if (this.#state === 'failed') return;
    this.#state = 'failed';
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#fenceReject?.(new RemoteDesktopError(code3));
    this.#fenceResolve = this.#fenceReject = void 0;
    this.onFailure(code3);
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
  constructor(code3, attachment2) {
    super(code3);
    this.attachment = attachment2;
    this.name = 'TigerVncSetupCleanupError';
  }
  attachment;
  retryCleanup(signal) {
    return this.attachment.close(signal);
  }
};
var TigerVncRfbSession = class _TigerVncRfbSession {
  constructor(options, socket, gate, attachment2) {
    this.options = options;
    this.socket = socket;
    this.gate = gate;
    this.attachment = attachment2;
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
    let attachment2;
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
        (code3) => {
          if (session) session.#fail(code3);
          else {
            gateFailure = code3;
            setup.abort();
          }
        }
      );
      attachment2 = new StandardRfbAttachment(socket, gate);
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
      session = new _TigerVncRfbSession(options, socket, gate, attachment2);
      session.#start();
      return session;
    } catch (error) {
      const ignore = () => {};
      if (!options.frontend.closed) {
        options.frontend.on('error', ignore);
        options.frontend.once('close', () => options.frontend.off('error', ignore));
      }
      options.frontend.destroy();
      if (attachment2) {
        try {
          await attachment2.close(AbortSignal.timeout(5e3));
        } catch (cleanupError) {
          throw new TigerVncSetupCleanupError(
            cleanupError instanceof RemoteDesktopError
              ? cleanupError.code
              : 'DESKTOP_NATIVE_CLEANUP_FAILED',
            attachment2
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
  #fail(code3) {
    if (this.#failed || this.#closed || this.#closing) return;
    this.#failed = true;
    void this.gate.fence().catch(() => {});
    this.#detach();
    try {
      this.options.onFailure(code3);
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
          onFailure: (code3) => {
            void this.close(AbortSignal.timeout(5e3)).catch(() => {});
            this.options.onFailure(code3);
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
      const token2 = /* @__PURE__ */ Symbol();
      this.#references.add(token2);
      return {
        backend,
        release: () => this.#serialize(() => this.#release(token2))
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
  async #release(token2) {
    if (!this.#references.has(token2)) return;
    if (this.#references.size === 1) {
      await this.#stopEmpty();
    }
    this.#references.delete(token2);
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

// mar-node/src/remote-desktop/macvnc-managed-process.ts
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
    const name2 = await io.read(nameLength);
    return { width, height, serverInit: Buffer.concat([header, name2]) };
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
  if (![8, 16, 32].includes(bpp) || depth === 0 || depth > bpp || format[3] === 0) return false;
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

// mar-node/src/remote-desktop/vnc-password.ts
import { createCipheriv as createCipheriv2 } from 'node:crypto';
function obfuscateVncPassword(password) {
  if (password.length !== 8 || password.includes(0))
    throw new Error('DESKTOP_BACKEND_CONFIG_INVALID');
  const key = Buffer.from('e84ad660c4721ae0'.repeat(3), 'hex');
  try {
    const cipher = createCipheriv2('des-ede3', key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(password), cipher.final()]);
  } finally {
    key.fill(0);
  }
}

// mar-node/src/remote-desktop/macvnc-managed-process.ts
var MacVncManagedProcess = class _MacVncManagedProcess {
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
    if (process.platform !== 'darwin' || !isAbsolute(options.binaryPath))
      throw new RemoteDesktopError('DESKTOP_BACKEND_CONFIG_INVALID');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(1e4)]);
    if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
    const directory = await mkdtemp(join(tmpdir(), 'mar-macvnc-'));
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const secret = randomBytes(8);
    for (let i = 0; i < secret.length; i++) secret[i] = alphabet.charCodeAt(secret[i] & 63);
    let backend;
    try {
      const port2 = await availableLoopbackPort();
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      const config = join(directory, 'vnc-password');
      const encoded = obfuscateVncPassword(secret);
      try {
        await writeFile(config, encoded, { flag: 'wx', mode: 384 });
      } finally {
        encoded.fill(0);
      }
      if (deadline.aborted) throw new RemoteDesktopError('DESKTOP_SETUP_CANCELLED');
      const child = spawn(
        options.binaryPath,
        [
          '-rfbport',
          String(port2),
          '-rfbportv6',
          '0',
          '-listen',
          '127.0.0.1',
          '-rfbauth',
          config,
          '-alwaysshared'
        ],
        {
          cwd: dirname(options.binaryPath),
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe']
        }
      );
      backend = new _MacVncManagedProcess(
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

// mar-node/src/remote-desktop/macos-remote-desktop-runtime.ts
var run = promisify(execFile);
function macosDesktopLayout(screens, generation, revision2) {
  const screen = screens.find((item) => item.primary);
  if (!screen) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
  const sx = screen.pixelWidth / screen.width;
  const sy = screen.pixelHeight / screen.height;
  const result = remoteDesktopDescriptionSchema.safeParse({
    desktopGeneration: generation,
    topologyRevision: revision2,
    framebuffer: { width: screen.pixelWidth, height: screen.pixelHeight },
    displays: [
      {
        displayId: `display_${screen.id}`,
        name: `Display ${screen.id}`,
        primary: true,
        nativeBounds: { x: screen.x, y: screen.y, width: screen.width, height: screen.height },
        framebufferBounds: { x: 0, y: 0, width: screen.pixelWidth, height: screen.pixelHeight },
        nativeToFramebuffer: [sx, 0, 0, sy, -screen.x * sx || 0, -screen.y * sy || 0]
      }
    ]
  });
  if (!result.success) throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
  return result.data;
}
async function queryScreens(binary, signal) {
  const { stdout } = await run(binary, [], { encoding: 'utf8', maxBuffer: 64 * 1024, signal });
  const parsed = JSON.parse(stdout);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('displays' in parsed) ||
    !Array.isArray(parsed.displays)
  )
    throw new RemoteDesktopError('DESKTOP_TOPOLOGY_UNAVAILABLE');
  return parsed.displays;
}
var MacosRemoteDesktopRuntime = class _MacosRemoteDesktopRuntime {
  constructor(options) {
    this.options = options;
    this.#pool = new TigerVncBackendPool(
      (signal, onUnexpectedExit) =>
        MacVncManagedProcess.start({ binaryPath: options.binaryPath, onUnexpectedExit }, signal),
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
    const runtime2 = new _MacosRemoteDesktopRuntime(options);
    await runtime2.refresh(signal);
    return runtime2;
  }
  async refresh(signal) {
    const screens = await queryScreens(this.options.topologyBinary, signal);
    const signature = JSON.stringify(screens.find((screen) => screen.primary));
    if (this.#disposed) throw new RemoteDesktopError('DESKTOP_BACKEND_CLOSED');
    if (signature === this.#signature) return;
    const layout = macosDesktopLayout(screens, this.#generation, this.#revision + 1);
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

// test/runs/macos-managed-runtime-probe/probe.ts
var [binaryPath, topologyBinary, port] = process.argv.slice(2);
if (!binaryPath || !topologyBinary || !port) throw new Error('Missing test arguments');
var runtime = await MacosRemoteDesktopRuntime.start(
  {
    binaryPath,
    topologyBinary,
    maxPixels: 67108864,
    fence: (code3) => console.log('fence', code3)
  },
  AbortSignal.timeout(2e4)
);
var desktop = runtime.describe();
console.log('TOPOLOGY', JSON.stringify(desktop));
var server = createServer2((socket) => {
  const attachment2 = runtime.createAttachment(
    {
      attachmentId: 'probe-attachment',
      mode: 'CONTROL',
      desktopGeneration: desktop.desktopGeneration,
      topologyRevision: desktop.topologyRevision
    },
    socket,
    { attached: () => console.log('ATTACHED'), failed: (code3) => console.error('FAILED', code3) }
  );
  let closing = false;
  const finish = async () => {
    if (closing) return;
    closing = true;
    try {
      await attachment2.close(AbortSignal.timeout(1e4));
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
  void attachment2.open(AbortSignal.timeout(2e4)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
    void finish();
  });
});
server.listen(Number(port), '127.0.0.1', () => console.log('READY'));

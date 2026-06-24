/**
 * Schema Validator — minimal JSON Schema subset validator without external deps.
 *
 * Supported:
 *   - type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
 *   - required: string[]
 *   - properties: { [key]: schema }
 *   - items: schema (for arrays)
 *   - enum: any[]
 *   - minLength / maxLength (strings)
 *   - minimum / maximum (numbers)
 *   - additionalProperties (boolean)
 *
 * Design rationale: we keep this in-repo instead of adding AJV because (a) the
 * Capability Registry schemas are small and authored by us, (b) fewer runtime
 * dependencies means faster cold start, (c) we can adjust validation ergonomics
 * (e.g. permissive extra fields) to match our conventions.
 */
import { Injectable, Logger } from '@nestjs/common';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type Schema = any;

@Injectable()
export class SchemaValidatorService {
  private readonly logger = new Logger(SchemaValidatorService.name);

  validate(data: any, schema: Schema, path = '$'): ValidationResult {
    const errors: string[] = [];
    this.validateNode(data, schema, path, errors);
    return { valid: errors.length === 0, errors };
  }

  private validateNode(data: any, schema: Schema, path: string, errors: string[]): void {
    if (schema == null || typeof schema !== 'object') return;

    // type
    if (schema.type) {
      const typeOk = this.checkType(data, schema.type);
      if (!typeOk) {
        errors.push(`${path}: expected type "${schema.type}", got ${this.typeof(data)}`);
        return;
      }
    }

    // enum
    if (Array.isArray(schema.enum)) {
      if (!schema.enum.includes(data)) {
        errors.push(`${path}: value must be one of [${schema.enum.join(', ')}]`);
      }
    }

    // Object
    if (schema.type === 'object' && data && typeof data === 'object' && !Array.isArray(data)) {
      if (Array.isArray(schema.required)) {
        for (const req of schema.required) {
          if (!(req in data) || data[req] === undefined || data[req] === null) {
            errors.push(`${path}.${req}: required field is missing`);
          }
        }
      }
      if (schema.properties && typeof schema.properties === 'object') {
        for (const [key, subSchema] of Object.entries(schema.properties)) {
          if (key in data) {
            this.validateNode(data[key], subSchema, `${path}.${key}`, errors);
          }
        }
      }
      if (schema.additionalProperties === false && schema.properties) {
        const allowed = new Set(Object.keys(schema.properties));
        for (const k of Object.keys(data)) {
          if (!allowed.has(k)) {
            errors.push(`${path}.${k}: additional properties not allowed`);
          }
        }
      }
    }

    // Array
    if (schema.type === 'array' && Array.isArray(data)) {
      if (schema.items) {
        data.forEach((item, i) => this.validateNode(item, schema.items, `${path}[${i}]`, errors));
      }
      if (typeof schema.minItems === 'number' && data.length < schema.minItems) {
        errors.push(`${path}: array must have at least ${schema.minItems} items`);
      }
      if (typeof schema.maxItems === 'number' && data.length > schema.maxItems) {
        errors.push(`${path}: array must have at most ${schema.maxItems} items`);
      }
    }

    // String
    if (schema.type === 'string' && typeof data === 'string') {
      if (typeof schema.minLength === 'number' && data.length < schema.minLength) {
        errors.push(`${path}: string too short (min ${schema.minLength})`);
      }
      if (typeof schema.maxLength === 'number' && data.length > schema.maxLength) {
        errors.push(`${path}: string too long (max ${schema.maxLength})`);
      }
      if (schema.pattern) {
        try {
          const re = new RegExp(schema.pattern);
          if (!re.test(data)) errors.push(`${path}: does not match pattern`);
        } catch {}
      }
    }

    // Number / integer
    if ((schema.type === 'number' || schema.type === 'integer') && typeof data === 'number') {
      if (typeof schema.minimum === 'number' && data < schema.minimum) {
        errors.push(`${path}: must be ≥ ${schema.minimum}`);
      }
      if (typeof schema.maximum === 'number' && data > schema.maximum) {
        errors.push(`${path}: must be ≤ ${schema.maximum}`);
      }
    }
  }

  private checkType(data: any, type: string): boolean {
    switch (type) {
      case 'object':
        return data !== null && typeof data === 'object' && !Array.isArray(data);
      case 'array':
        return Array.isArray(data);
      case 'string':
        return typeof data === 'string';
      case 'number':
        return typeof data === 'number';
      case 'integer':
        return typeof data === 'number' && Number.isInteger(data);
      case 'boolean':
        return typeof data === 'boolean';
      case 'null':
        return data === null;
      default:
        return true; // permissive for unknown types
    }
  }

  private typeof(data: any): string {
    if (data === null) return 'null';
    if (Array.isArray(data)) return 'array';
    return typeof data;
  }
}

export class Fault extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'Fault'; this.code = code; Object.assign(this, detail); }
}
export const assert = (condition, code, message) => { if (!condition) throw new Fault(code, message); };
export function errorData(error) {
  return { code: error.code || 'INTERNAL_ERROR', message: error.message || 'Unknown failure',
    ...(error.status ? {http_status:error.status} : {}), ...(error.uncertain ? {uncertain:true} : {}),
    ...(error.details ? {details:error.details} : {}) };
}


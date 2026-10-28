// Minimale Typen für den Khronos-glTF-Validator (nur in Tests genutzt, bringt keine eigenen Typen mit).
declare module "gltf-validator" {
  interface Message {
    code: string;
    message: string;
    severity: 0 | 1 | 2 | 3;
    pointer?: string;
  }
  interface Report {
    info: { version: string };
    issues: { numErrors: number; numWarnings: number; messages: Message[] };
  }
  interface Options {
    maxIssues?: number;
  }
  const validator: {
    validateBytes(data: Uint8Array, options?: Options): Promise<Report>;
    validateString(json: string, options?: Options): Promise<Report>;
  };
  export default validator;
}

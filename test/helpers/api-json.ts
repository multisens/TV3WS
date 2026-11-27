// The JSON body of a response, read field by field in the assertions; a
// field the response lacks reads as undefined and fails the assertion.
export type ApiJson = { error: number; description: string; [field: string]: unknown };

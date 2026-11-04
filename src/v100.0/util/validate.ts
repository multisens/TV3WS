import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { returnError } from '../../util';

// Returns a middleware that validates req.body against the schema. If the
// body is valid, replaces req.body with the parsed body, without unknown
// fields, and calls next(). Otherwise, responds:
// - the error in params.error of the first custom issue that has it, with
//   the issue message;
// - error 101 if the body is not a JSON object;
// - error 105 with every top-level field missing in the body;
// - error 101 with the top-level field of the first issue.
export function validateSchema(schema: z.ZodType) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const result = schema.safeParse(req.body);
        if (result.success) {
            req.body = result.data;
            next();
            return;
        }
        const issues = result.error.issues;

        const coded = issues.find((issue) => errorCodeOf(issue) !== undefined);
        if (coded) {
            returnError(res, errorCodeOf(coded)!, coded.message);
            return;
        }

        if (issues.some((issue) => issue.path.length === 0)) {
            returnError(res, 101, 'message body');
            return;
        }

        const missing = issues
            .filter((issue) => issue.path.length === 1 && req.body[issue.path[0]] === undefined)
            .map((issue) => String(issue.path[0]));
        if (missing.length > 0) {
            returnError(res, 105, missing.join(', '));
            return;
        }

        returnError(res, 101, String(issues[0].path[0]));
    };
}

// Returns params.error of a custom issue, if it is a number
function errorCodeOf(issue: z.core.$ZodIssue): number | undefined {
    if (issue.code !== 'custom') {
        return undefined;
    }
    const code = issue.params?.error;
    return typeof code === 'number' ? code : undefined;
}

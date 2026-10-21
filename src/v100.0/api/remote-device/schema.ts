import { z } from 'zod';

// C.6.15.2, Table C.76: body of the registration and of the update
export const RegisterBodySchema = z.object({
    deviceClass: z.string(),
    supportedTypes: z.array(z.string()),
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

import { z } from 'zod';

// C.6.15.2, Table C.76: body of the registration and of the update; an
// empty deviceClass is an invalid value
export const RegisterBodySchema = z.object({
    deviceClass: z.string().min(1),
    supportedTypes: z.array(z.string()),
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

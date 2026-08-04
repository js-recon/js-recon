import { z } from "zod";

const requestStepSchema = z.union([
    z.object({
        type: z.literal("headers"),
        condition: z.enum(["contains", "absent"]),
        name: z.string(),
    }),
    z.object({
        type: z.literal("url"),
        condition: z.enum(["contains", "absent"]),
        name: z.string(),
    }),
    z.object({
        type: z.literal("method"),
        condition: z.enum(["is", "is_not"]),
        name: z.string(),
    }),
]);

const esqueryStepSchema = z.object({
    type: z.literal("esquery"),
    query: z.string(),
    inScopeOf: z.string().optional(),
    taintFrom: z.string().optional(),
});

const PostMessageFuncResolverStepSchema = z.object({
    name: z.string(),
});

const checkAssignmentExistStepSchema = z.object({
    name: z.string(),
    type: z.string(),
    memberExpression: z.boolean().optional(),
});

const regexMatchStepSchema = z.object({
    pattern: z.string(),
});

const csMastSStepSchema = z.object({
    signature: z.string(),
});

const stepSchema = z.object({
    name: z.string(),
    message: z.string(),
    requires: z.array(z.string()).optional(),
    request: requestStepSchema.optional(),
    esquery: esqueryStepSchema.optional(),
    postMessageFuncResolve: PostMessageFuncResolverStepSchema.optional(),
    checkAssignmentExist: checkAssignmentExistStepSchema.optional(),
    regexMatch: regexMatchStepSchema.optional(),
    csMastS: csMastSStepSchema.optional(),
});

export const ruleSchema = z.object({
    id: z.string(),
    name: z.string(),
    author: z.string(),
    description: z.string(),
    js_recon_version: z.string(),
    js_recon_max_version: z.string().optional(),
    tech: z.array(z.enum(["next", "vue", "react", "svelte", "angular", "all"])),
    severity: z.enum(["info", "low", "medium", "high"]),
    type: z.enum(["request", "ast", "cs-mast-s"]),
    steps: z.array(stepSchema),
});

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

const taintwireStepSchema = z.object({
    query: z.union([z.string(), z.array(z.string()).min(1)]),
    taintFrom: z.string().optional(),
    mode: z.enum(["strict", "lenient", "deep"]).optional(),
    maxHops: z.number().int().positive().optional(),
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
    taintwire: taintwireStepSchema.optional(),
});

export const ruleSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        author: z.string(),
        description: z.string(),
        js_recon_version: z.string(),
        js_recon_max_version: z.string().optional(),
        tech: z.array(z.enum(["next", "vue", "react", "svelte", "angular", "all"])),
        severity: z.enum(["info", "low", "medium", "high"]),
        type: z.enum(["request", "ast", "cs-mast-s", "taintwire"]),
        prefilter: z.string().optional(),
        steps: z.array(stepSchema),
    })
    .refine(
        (r) => r.type !== "taintwire" || r.steps.every((s) => s.taintwire && /^[A-Za-z_]\w*$/.test(s.name)),
        // step names become Cypher parameters ($<name>) for later steps
        { message: "every step of a taintwire rule needs a taintwire block and a name made of letters, digits and _" }
    )
    .refine(
        (r) => {
            try {
                return !r.prefilter || !!new RegExp(r.prefilter);
            } catch {
                return false;
            }
        },
        { message: "prefilter must be a valid regular expression", path: ["prefilter"] }
    );

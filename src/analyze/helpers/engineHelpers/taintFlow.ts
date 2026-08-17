import { Node } from "@babel/types";
import traverse, { NodePath, Binding } from "@babel/traverse";

export type TaintInfo = {
    bindings: Set<NodePath>;
    memberChains: Set<string>;
    sourceNodes: Set<Node>;
};

const memberChainString = (node: Node): string | null => {
    if (node.type === "Identifier") return node.name;
    if (node.type === "ThisExpression") return "this";
    if (node.type === "MemberExpression") {
        if (node.computed) return null;
        if (node.property.type !== "Identifier") return null;
        const obj = memberChainString(node.object);
        if (!obj) return null;
        return `${obj}.${node.property.name}`;
    }
    return null;
};

const collectIdsFromPattern = (node: Node): string[] => {
    if (!node) return [];
    if (node.type === "Identifier") return [node.name];
    if (node.type === "ObjectPattern") {
        return node.properties.flatMap((p) => {
            if (p.type === "ObjectProperty") return collectIdsFromPattern(p.value as Node);
            if (p.type === "RestElement") return collectIdsFromPattern(p.argument as Node);
            return [];
        });
    }
    if (node.type === "ArrayPattern") {
        return node.elements.flatMap((e) => (e ? collectIdsFromPattern(e as Node) : []));
    }
    if (node.type === "AssignmentPattern") return collectIdsFromPattern(node.left as Node);
    if (node.type === "RestElement") return collectIdsFromPattern(node.argument as Node);
    return [];
};

const expressionIsTainted = (path: NodePath, taint: TaintInfo): boolean => {
    if (taint.sourceNodes.has(path.node)) return true;
    let tainted = false;
    const visit = (p: NodePath) => {
        if (tainted) return;
        if (taint.sourceNodes.has(p.node)) {
            tainted = true;
            p.stop();
            return;
        }
        if (p.node.type === "Identifier") {
            // skip identifiers that are property keys / declarations themselves
            const parent = p.parent;
            if (
                parent &&
                ((parent.type === "MemberExpression" && parent.property === p.node && !parent.computed) ||
                    (parent.type === "ObjectProperty" && parent.key === p.node && !parent.computed) ||
                    (parent.type === "VariableDeclarator" && (parent as any).id === p.node) ||
                    (parent.type === "FunctionDeclaration" && (parent as any).id === p.node) ||
                    (parent.type === "ClassDeclaration" && (parent as any).id === p.node))
            ) {
                return;
            }
            const binding = p.scope.getBinding(p.node.name);
            if (binding && taint.bindings.has(binding.path)) {
                tainted = true;
                p.stop();
                return;
            }
        }
        if (p.node.type === "MemberExpression") {
            const chain = memberChainString(p.node);
            if (chain && taint.memberChains.has(chain)) {
                tainted = true;
                p.stop();
                return;
            }
        }
    };
    visit(path);
    if (!tainted) {
        path.traverse({
            enter(p) {
                visit(p);
            },
        });
    }
    return tainted;
};

/**
 * Compute the taint info for a chunk AST given the source nodes (URL-derived reads).
 *
 * Performs scope-aware iterative propagation:
 *   - Variable declarators / assignment expressions whose right-hand side
 *     contains a tainted source node or references a tainted binding/member
 *     chain are themselves tainted.
 *   - Tainted bindings are tracked by their declaration NodePath; tainted
 *     member chains (e.g. `R.current`) are tracked as strings.
 */
export const computeTaint = (ast: Node, sourceNodes: Node[]): TaintInfo => {
    const taint: TaintInfo = {
        bindings: new Set<NodePath>(),
        memberChains: new Set<string>(),
        sourceNodes: new Set<Node>(sourceNodes),
    };

    // Bound iteration count to avoid pathological cases
    const maxRounds = 8;
    for (let round = 0; round < maxRounds; round++) {
        let changed = false;

        traverse(ast, {
            VariableDeclarator(path) {
                if (!path.node.init) return;
                const initPath = path.get("init") as NodePath;
                if (!expressionIsTainted(initPath, taint)) return;
                const names = collectIdsFromPattern(path.node.id as Node);
                for (const name of names) {
                    const binding = path.scope.getBinding(name);
                    if (binding && !taint.bindings.has(binding.path)) {
                        taint.bindings.add(binding.path);
                        changed = true;
                    }
                }
            },
            AssignmentExpression(path) {
                const rightPath = path.get("right") as NodePath;
                if (!expressionIsTainted(rightPath, taint)) return;
                const left = path.node.left as Node;
                if (left.type === "Identifier") {
                    const binding = path.scope.getBinding(left.name);
                    if (binding && !taint.bindings.has(binding.path)) {
                        taint.bindings.add(binding.path);
                        changed = true;
                    }
                } else if (left.type === "MemberExpression") {
                    const chain = memberChainString(left);
                    if (chain && !taint.memberChains.has(chain)) {
                        taint.memberChains.add(chain);
                        changed = true;
                    }
                } else if (left.type === "ObjectPattern" || left.type === "ArrayPattern") {
                    const names = collectIdsFromPattern(left);
                    for (const name of names) {
                        const binding = path.scope.getBinding(name);
                        if (binding && !taint.bindings.has(binding.path)) {
                            taint.bindings.add(binding.path);
                            changed = true;
                        }
                    }
                }
            },
            // Propagate taint through callback parameters: when a tainted value is
            // passed alongside an inline function argument (e.g. watch(tainted, cb)),
            // the function's parameters may receive the tainted value at call time.
            CallExpression(path) {
                const argPaths = path.get("arguments") as NodePath[];
                let hasTaintedNonFunction = false;
                const inlineFnPaths: NodePath[] = [];
                for (const argPath of argPaths) {
                    const t_ = argPath.node.type;
                    if (t_ === "ArrowFunctionExpression" || t_ === "FunctionExpression") {
                        inlineFnPaths.push(argPath);
                    } else if (expressionIsTainted(argPath, taint)) {
                        hasTaintedNonFunction = true;
                    }
                }
                if (hasTaintedNonFunction) {
                    for (const fnPath of inlineFnPaths) {
                        const fnNode = fnPath.node as any;
                        for (const param of fnNode.params || []) {
                            const names = collectIdsFromPattern(param as Node);
                            for (const name of names) {
                                const binding = fnPath.scope.getBinding(name);
                                if (binding && !taint.bindings.has(binding.path)) {
                                    taint.bindings.add(binding.path);
                                    changed = true;
                                }
                            }
                        }
                    }
                }
            },
        });

        if (!changed) break;
    }

    return taint;
};

const getSinkValueNodes = (sink: Node): Node[] => {
    switch (sink.type) {
        case "AssignmentExpression":
            return [sink.right as Node];
        case "CallExpression":
        case "NewExpression": {
            const args = (sink as any).arguments as Node[];
            return args.filter((a) => a && a.type !== "SpreadElement");
        }
        case "ObjectProperty": {
            const v = (sink as any).value as Node | null | undefined;
            // For computed properties (e.g. { [userInput]: "val" }), the taint may be in
            // the key rather than the value — include both so taint-from checks fire correctly.
            const k = (sink as any).computed ? ((sink as any).key as Node | null | undefined) : undefined;
            const nodes: Node[] = [];
            if (v) nodes.push(v);
            if (k) nodes.push(k);
            return nodes.length > 0 ? nodes : [sink];
        }
        case "JSXAttribute": {
            // Boolean JSX attributes (e.g. `<div hidden />`) have no value node.
            const v = (sink as any).value as Node | null | undefined;
            return v ? [v] : [];
        }
        default:
            return [sink];
    }
};

/**
 * Returns true when `sinkNode` consumes a value tainted by the URL source(s) used
 * to compute `taint`. Walks the sink's value-side subtree (RHS for assignments,
 * arguments for calls/new, value for object/JSX properties) and looks for:
 *   - direct references to a tainted source subtree,
 *   - identifiers whose binding is in `taint.bindings`,
 *   - member-expression chains in `taint.memberChains`.
 *
 * To resolve scope-aware bindings, we re-traverse the AST and pick up paths
 * whose nodes match one of the value-side subtrees.
 */
export const sinkConsumesTaint = (ast: Node, sinkNode: Node, taint: TaintInfo): boolean => {
    const valueRoots = new Set<Node>(getSinkValueNodes(sinkNode));
    if (valueRoots.size === 0) return false;

    let consumed = false;
    traverse(ast, {
        enter(path: NodePath<Node>) {
            if (consumed) {
                path.stop();
                return;
            }
            if (!valueRoots.has(path.node)) return;
            if (expressionIsTainted(path, taint)) {
                consumed = true;
                path.stop();
            }
        },
    });
    return consumed;
};

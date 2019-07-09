/*
 * Copyright © 2019 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { projectUtils } from "@atomist/automation-client";
import {
    AutoCodeInspection,
    Autofix,
    AutofixRegistration,
    CodeInspectionRegistration,
    doWithProject,
    Fingerprint,
    goal,
    Goal,
    goals,
    Goals,
    GoalsBuilder,
    GoalWithFulfillment,
    isMaterialChange,
    LogSuppressor,
    pushTest,
    PushTest,
} from "@atomist/sdm";
import {
    cachePut,
    cacheRemove,
    cacheRestore,
    GoalCacheOptions,
    Tag,
    Version,
} from "@atomist/sdm-core";
import {
    AutofixRegisteringInterpreter,
    CodeInspectionRegisteringInterpreter,
    Interpretation,
    Interpreter,
} from "@atomist/sdm-pack-analysis";
import { Build } from "@atomist/sdm-pack-build";
import {
    DockerBuild,
    DockerProgressReporter,
} from "@atomist/sdm-pack-docker";
import {
    EslintAutofix,
    EslintInspection,
    nodeBuilder,
    NodeDefaultOptions,
    NodeProjectVersioner,
    NpmCompileProjectListener,
    NpmInstallProjectListener,
    NpmVersionProjectListener,
    TslintAutofix,
    TslintInspection,
} from "@atomist/sdm-pack-node";
import { npmAuditInspection } from "@atomist/sdm-pack-node/lib/inspection/npmAudit";
import {
    getParsedPackageJson,
    hasDependency,
    NodeStack,
} from "./nodeScanner";

export interface NodeDeliveryOptions {
    createBuildGoal: () => Build;
    createTestGoal: () => GoalWithFulfillment;
    configureTestGoal?: (testGoal: GoalWithFulfillment) => void;
}

const HasTypescript: PushTest = pushTest("hasTypescript", async push => {
    return getParsedPackageJson(push.project).then(pj => hasDependency(pj, "typescript")).catch(() => false);
});

const NodeModulesCacheOptions: GoalCacheOptions = {
    entries: [
        { classifier: "nodeModules", pattern: { directory: "node_modules" } },
    ],
    onCacheMiss: [NpmInstallProjectListener],
};

const CompiledTypescriptCacheOptions: GoalCacheOptions = {
    entries: [
        { classifier: "compiledTypescript", pattern: { globPattern: ["**/*.{js,js.map,d.ts}", "!node_modules/**/*"] } },
    ],
    pushTest: HasTypescript,
    onCacheMiss: [NpmCompileProjectListener],
};

export class NodeBuildInterpreter implements Interpreter, AutofixRegisteringInterpreter, CodeInspectionRegisteringInterpreter {

    private readonly versionGoal: Version = new Version().withVersioner(NodeProjectVersioner);

    private readonly dockerBuildGoal: DockerBuild = new DockerBuild()
        .with({
            progressReporter: DockerProgressReporter,
            logInterpreter: LogSuppressor,
        })
        .withProjectListener(NpmVersionProjectListener)
        .withProjectListener(cacheRestore(NodeModulesCacheOptions))
        .withProjectListener(cacheRestore(CompiledTypescriptCacheOptions))
        .withProjectListener(cacheRemove(NodeModulesCacheOptions))
        .withProjectListener(cacheRemove(CompiledTypescriptCacheOptions));

    private readonly tagGoal: Tag = new Tag();

    private readonly buildGoal: Build;

    private readonly testGoal: Goal;

    // tslint:disable-next-line:cyclomatic-complexity
    public async enrich(interpretation: Interpretation): Promise<boolean> {
        const nodeStack = interpretation.reason.analysis.elements.node as NodeStack;
        if (!nodeStack) {
            return false;
        }

        const hasBuild = !!(nodeStack.packageJson.scripts || {}).build;

        if (hasBuild && !interpretation.buildGoals) {
            interpretation.buildGoals = goals("build")
                .plan(this.versionGoal)
                .plan(this.buildGoal).after(this.versionGoal);
        }

        const hasTest = !!(nodeStack.packageJson.scripts || {}).test;
        if (hasTest) {
            interpretation.testGoals = goals("test")
                .plan(this.testGoal);
            if (!hasBuild) {
                interpretation.buildGoals = goals("build")
                    .plan(this.versionGoal);
            }
        }

        if (hasTest || hasBuild) {
            interpretation.releaseGoals = goals("release").plan(this.tagGoal);
        }

        let checkGoals: Goals & GoalsBuilder = goals("checks");
        if (!!interpretation.checkGoals) {
            checkGoals = goals("checks").plan(interpretation.checkGoals).plan(interpretation.checkGoals);
        }
        interpretation.checkGoals = checkGoals;

        if (nodeStack.hasDockerFile) {
            interpretation.containerBuildGoals = goals("docker build")
                .plan(this.dockerBuildGoal);
        }

        if (!!nodeStack.javaScript) {
            if (!!nodeStack.javaScript.eslint) {
                const eslint = nodeStack.javaScript.eslint;
                if (eslint.hasDependency && eslint.hasConfig) {
                    interpretation.autofixes.push(EslintAutofix);
                    interpretation.inspections.push(EslintInspection, npmAuditInspection());
                }
            }
        }

        if (!!nodeStack.typeScript) {
            if (!!nodeStack.typeScript.tslint) {
                const tslint = nodeStack.typeScript.tslint;
                if (tslint.hasConfig) {
                    interpretation.autofixes.push(TslintAutofix);
                    interpretation.inspections.push(TslintInspection, npmAuditInspection());
                }
            }
        }

        interpretation.materialChangePushTests.push(isMaterialChange({
            files: ["Dockerfile"],
            extensions: ["ts", "js", "jsx", "tsx", "json", "pug", "html", "css"],
            directories: [".atomist"],
        }));

        return true;
    }

    get autofixes(): AutofixRegistration[] {
        return [EslintAutofix, TslintAutofix];
    }

    public configureAutofixGoal(autofix: Autofix): void {
        autofix.withProjectListener(cacheRestore(NodeModulesCacheOptions));
    }

    get codeInspections(): Array<CodeInspectionRegistration<any>> {
        return [EslintInspection, TslintInspection, npmAuditInspection()];
    }

    public configureCodeInspectionGoal(codeInspection: AutoCodeInspection): void {
        codeInspection.withProjectListener(cacheRestore(NodeModulesCacheOptions));
    }

    constructor(opts: Partial<NodeDeliveryOptions> = {}) {
        const optsToUse: NodeDeliveryOptions = {
            createBuildGoal: createDefaultBuildGoal,
            createTestGoal: createDefaultTestGoal,
            ...opts,
        };
        this.buildGoal = optsToUse.createBuildGoal();

        const testGoal = optsToUse.createTestGoal();
        if (optsToUse.configureTestGoal) {
            optsToUse.configureTestGoal(testGoal);
        }
        this.testGoal = testGoal;
    }
}

function createDefaultBuildGoal(): Build {
    return new Build({
        displayName: "npm build",
        isolate: true,
    }).with({
        ...NodeDefaultOptions,
        name: "npm-run-build",
        builder: nodeBuilder({ command: "npm", args: ["run", "build"] }),
    })
        .withProjectListener(NpmInstallProjectListener)
        .withProjectListener(cachePut(CompiledTypescriptCacheOptions))
        .withProjectListener(cachePut(NodeModulesCacheOptions));
}

function createDefaultTestGoal(): GoalWithFulfillment {
    return goal({
        displayName: "npm test",
        retry: true,
        isolate: true,
        descriptions: {
            inProcess: "Running NPM test",
            failed: "Test failures from NPM test",
            completed: "NPM test passed",
        },
    }).with({
        ...NodeDefaultOptions,
        name: "npm-run-test",
        goalExecutor: doWithProject(
            async gi => {
                return gi.spawn("npm", ["run", "test"]);
            },
        ),
    })
        .withProjectListener(cacheRestore(NodeModulesCacheOptions))
        .withProjectListener(cacheRestore(CompiledTypescriptCacheOptions));
}

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

import {
    Project,
    projectUtils,
    RegexFileParser,
} from "@atomist/automation-client";
import { matchIterator } from "@atomist/automation-client/lib/tree/ast/astUtils";
import { SdmContext } from "@atomist/sdm";
import {
    Service,
    TechnologyScanner,
    TechnologyStack,
} from "@atomist/sdm-pack-analysis";
import {
    FastProject,
    PhasedTechnologyScanner,
    TechnologyClassification,
} from "@atomist/sdm-pack-analysis/lib/analysis/TechnologyScanner";
import { PackageJson } from "@atomist/sdm-pack-node";
import * as _ from "lodash";

export interface TypeScriptInfo {
    hasDependency: boolean;
    version: string;
    tslint: {
        hasConfig: boolean;
        hasDependency: boolean;
    };
}

export interface JavaScriptInfo {

    eslint: {
        hasConfig: boolean;
        hasDependency: boolean;
    };
}

/**
 * Subset of PackageJson to persist with analysis to avoid serialized data
 * structure being excessively large.
 */
export type PackageJsonSummary = Pick<PackageJson, "name" | "description" | "author" | "version" | "scripts">;

/**
 * Represents use of Node in a project
 */
export interface NodeStack extends TechnologyStack {

    name: "node";

    typeScript?: TypeScriptInfo;

    javaScript?: JavaScriptInfo;

    packageJson: PackageJsonSummary;

    hasDockerFile: boolean;

    dockerFile: string;

}

export class NodeScanner implements PhasedTechnologyScanner<NodeStack> {

    public async classify(p: FastProject, ctx: SdmContext): Promise<TechnologyClassification | undefined> {
        try {
            const packageJson = await getParsedPackageJson(p);
            if (!!packageJson.scripts) {
                const messages = [];
                if (!packageJson.scripts.build) {
                    messages.push("Project's `package.json` has no `build` script. Please add a script to enable a build goal");
                }
                if (!packageJson.scripts.test) {
                    messages.push("Project's `package.json` has no `test` script. Please add a script to enable a test goal");
                }
                return {
                    name: "node",
                    tags: ["node"],
                    messages,
                };
            } else {
                return undefined;
            }

        } catch (e) {
            return undefined;
        }
    }

    get scan(): TechnologyScanner<NodeStack> {
        return nodeScanner;
    }
}

/**
 * Scanner to find use of Node in a project.
 */
export const nodeScanner: TechnologyScanner<NodeStack> = async p => {
    try {
        const packageJson = await getParsedPackageJson(p);

        // Extract the information we want to summarize
        const packageJsonSummary: PackageJsonSummary = {
            author: packageJson.author,
            name: packageJson.name,
            description: packageJson.description,
            scripts: packageJson.scripts || {},
            version: packageJson.version,
        };

        const javaScriptInto: JavaScriptInfo = {
            eslint: {
                hasConfig: await p.hasFile(".eslintrc") || await p.hasFile(" .eslintrc.json"),
                hasDependency: hasDependency(packageJson, "eslint"),
            },
        };

        const typeScriptInfo: TypeScriptInfo = {
            hasDependency: hasDependency(packageJson, "typescript"),
            version: getDependencyVersion(packageJson, "typescript"),
            tslint: {
                hasConfig: await p.hasFile("tslint.json"),
                hasDependency: hasDependency(packageJson, "tslint"),
            },
        };

        // Add services per our dependencies
        const services: Record<string, Service> = {};
        if (hasDependency(packageJson, "mongoose", "mongodb")) {
            services.mongodb = {};
        }

        let dockerFile: string;
        await projectUtils.doWithFiles(p, "**/Dockerfile", f => {
            dockerFile = f.path;
        });

        const stack: NodeStack = {
            projectName: packageJsonSummary.name,
            packageJson: packageJsonSummary,
            name: "node",
            tags: ["node"],
            referencedEnvironmentVariables: await findEnvironmentVariables(p),
            dependencies: Object.getOwnPropertyNames(packageJson.dependencies || {}).map(name => {
                return {
                    // TODO should probably parse this better
                    group: name,
                    artifact: name,
                    version: packageJson.dependencies[name],
                };
            }),
            hasDockerFile: !!dockerFile,
            dockerFile,
            javaScript: javaScriptInto,
            typeScript: typeScriptInfo,
            services,
        };
        return stack;
    } catch {
        // Ill-formed JSON
        return undefined;
    }
};

const envReferenceParser = new RegexFileParser({
    rootName: "envs",
    matchName: "env",
    regex: /process\.env\.([A-Za-z0-9_]+)/,
    captureGroupNames: ["name"],
});

/**
 * Find all environment variables referenced in JavaScript or TypeScript
 * via process.env.KEY
 */
async function findEnvironmentVariables(p: Project): Promise<string[]> {
    const it = matchIterator<{ name: string }>(p, {
        parseWith: envReferenceParser,
        globPatterns: ["**/*.js", "**/*.ts"],
        pathExpression: "//envs/env",
    });
    const matches: string[] = [];
    for await (const match of it) {
        if (!matches.includes(match.name)) {
            matches.push(match.name);
        }
    }
    return matches;
}

export async function getParsedPackageJson(p: Project): Promise<PackageJson> {
    const packageJsonFile = await p.getFile("package.json");
    if (!packageJsonFile) {
        return Promise.reject("No package json");
    }
    const packageJsonStr = await packageJsonFile.getContent();
    return JSON.parse(packageJsonStr) as PackageJson;
}

/**
 * Check if a given package json expresses a dependency
 */
export function hasDependency(pj: PackageJson, ...dependencies: string[]): boolean {
    for (const dependency of dependencies) {
        if (!!_.get(pj, `dependencies.${dependency}`)
            || !!_.get(pj, `devDependencies.${dependency}`)) {
            return true;
        }
    }
    return false;
}

/**
 * Check if a given package json expresses a dependency
 */
export function getDependencyVersion(pj: PackageJson, dependency: string): string {
    const dep = _.get(pj, `dependencies.${dependency}`);
    const devDep = _.get(pj, `devDependencies.${dependency}`);
    return dep || devDep;
}

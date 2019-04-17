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

import { editModes } from "@atomist/automation-client";
import {
    CodeTransformRegistration,
    formatDate,
} from "@atomist/sdm";

/**
 * CodeTransform to add/or overwrite a new package.json script element
 */
export const PackageScriptCodeTransform: CodeTransformRegistration<{ script: string, content: string }> = {
    name: "PackageScriptCodeTransform",
    description: "Add a script element to a project's package.json",
    parameters: {
        script: { displayable: false },
        content: {
            required: false,
            description: "Content of package.json script element",
        },
    },
    transform: async (p, papi) => {
        const pjFile = await p.getFile("package.json");
        const pj = JSON.parse(await pjFile.getContent());
        // tslint:disable-next-line:no-invalid-template-strings
        pj.scripts[papi.parameters.script] = papi.parameters.content || "<please add your script here>";
        await pjFile.setContent(JSON.stringify(pj, undefined, 2));
        return p;
    },
    transformPresentation: (ci, p) => {
        return new editModes.PullRequest(
            `package-${ci.parameters.script}-script-${formatDate()}`,
            `Add ${ci.parameters.script} to package.json`,
        );
    },
};

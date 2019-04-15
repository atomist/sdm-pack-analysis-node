import { PullRequest } from "@atomist/automation-client/lib/operations/edit/editModes";
import {
    CodeTransformRegistration,
    formatDate,
} from "@atomist/sdm";

export const PackageScriptCodeTransform: CodeTransformRegistration<{ script: string }> = {
    name: "PackageScriptCodeTransform",
    parameters: { script: {} },
    transform: async (p, papi) => {
        const pjFile = await p.getFile("package.json");
        const pj = JSON.parse(await pjFile.getContent());
        // tslint:disable-next-line:no-invalid-template-strings
        pj.scripts[papi.parameters.script] = "<please add your script here>";
        await pjFile.setContent(JSON.stringify(pj, undefined, 2));
        return p;
    },
    transformPresentation: (ci, p) => {
        return new PullRequest(
            `package-${ci.parameters.script}-script-${formatDate()}`,
            "Add empty ${ci.parameters.script} to package.json",
        );
    },
};

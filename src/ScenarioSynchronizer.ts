import * as TestrailApiClient from 'testrail-api';
import * as path from 'path';
import * as S from 'string';
import * as chalk from 'chalk';
import * as jsdiff from 'diff';
import * as fs from 'fs';
import * as inquirer from 'inquirer';
import * as _ from 'lodash';
import * as Joi from 'joi';
import * as walk from 'walkdir';
import * as uniquefilename from 'uniquefilename';
import * as mkdirp from 'mkdirp';
import * as Handlebars from 'handlebars';
import {ScenarioSynchronizerOptions} from '../index.d';

interface Step {
    keyword: string;
    regex: string;
    isStringPattern?: boolean;
    regexFlags?: string;
    used?: boolean;
    filename?: string;
    pattern?: string;
}

interface TestRun {
    id: any;
}

interface TestPlan {
    project_id: number;
    entries: [TestPlanEntry];
}

interface TestPlanEntry {
    id: string;
    name: string;
    runs: [TestRun];
    suite_id: number;
}

export class ScenarioSynchronizer {
    protected config: ScenarioSynchronizerOptions;
    protected templateDir: string;
    protected testrailClient: any;
    protected plan: TestPlan;
    protected caseSections: any;
    protected sectionTree: any;
    protected testFiles: any;
    protected implementedSteps: Step[];
    protected skippedCount: number;
    public static forcedPrompt: any;

    public async synchronize(config: ScenarioSynchronizerOptions, callback: Function): Promise<void> {
        const defaultConfig = {
            indent: '  '
        };

        const schema = Joi.object().keys(<any> {
            testrail: {
                host: Joi.string().required(),
                user: Joi.string().required(),
                password: Joi.string().required(),
                filters: {
                    plan_id: Joi.number().required(),
                    run_id: Joi.number().default(0),
                    custom_status: Joi.array().items(Joi.number())
                },
                verifyFilters: {
                    custom_status: Joi.array().items(Joi.number())
                }
            },
            featuresDir: Joi.string().required(),
            stepDefinitionsDir: Joi.string().required(),
            overwrite: {
                local: Joi.any().valid([true, false, 'ask']),
                remote: Joi.any().valid([true, false, 'ask'])
            },
            stepDefinitionsTemplate: Joi.string(),
            stepDefinitionsStringPatterns: Joi.boolean().default(false),
            indent: Joi.string().required(),
            silent: Joi.boolean().default(false),
            directoryStructure: {
                type: Joi.any().valid(['section:slug', 'section:name']),
                skipRootFolder: Joi.number().default(0)
            },
            verify: Joi.boolean().default(false),
            findUnused: Joi.boolean().default(false),
            pushResults: Joi.boolean().default(false)
        });

        this.config = <ScenarioSynchronizerOptions> _.defaultsDeep(config, defaultConfig);

        this.templateDir = path.resolve(__dirname, '..', 'templates');

        try {
            await this.validateConfig(schema);

            if (this.config.findUnused === true) {
                await this.findImplementedStepDefinitions();
                const errors = await this.findUnusedStepDefinitions();

                if (errors.length) {
                    throw new Error(errors.join('\n'));
                } else {
                    this.output(chalk.green('OK'));
                }
            } else if (this.config.verify === true) {
                await this.fetchTestPlanAndSections();
                await this.findImportedTestcases();
                const errors = await this.verifySync();

                if (errors.length) {
                    throw new Error(errors.join('\n'));
                } else {
                    this.output(chalk.green('OK'));
                }
            } else {
                await this.fetchTestPlanAndSections();
                await this.findImportedTestcases();
                await this.findImplementedStepDefinitions();
                await this.synchronizePlan();
            }

            callback();
        } catch (err) {
            this.output(chalk.red('Error:'));
            const errorMessage = err.message || err;
            if (_.isString(errorMessage)) {
                this.output(chalk.red(errorMessage));
            } else {
                this.output(err);
            }

            callback(err);
        }
    }

    protected output(s: any): void {
        /* istanbul ignore next */
        if (!this.config.silent) {
            console.log(s);
        }
    }

    protected validateConfig(schema: any): Promise<any> {
        return new Promise((resolve: Function, reject: Function) => {
            return Joi.validate(this.config, schema, (err: any) => {
                if (err) {
                    return reject(err);
                }

                // Validate the overwrite config
                if (this.config.overwrite === undefined) {
                    this.config.overwrite = {
                        local: false,
                        remote: false
                    };
                }

                if (this.config.overwrite.local === undefined) {
                    this.config.overwrite.local = false;
                }

                if (this.config.overwrite.remote === undefined) {
                    this.config.overwrite.remote = false;
                }

                if (this.config.overwrite.local !== false && this.config.overwrite.remote !== false) {
                    return reject(new Error('Validation error: overwrite.local and overwrite.remote cannot be both defined'));
                }

                // Validate that the specified template does exist
                if (this.config.stepDefinitionsTemplate) {
                    const templateFile = path.resolve(this.templateDir, this.config.stepDefinitionsTemplate + '.hbs');
                    return fs.stat(templateFile, (err2: any, stat: any): any => {
                        if (err2) {
                            if (err2.code === 'ENOENT') {
                                return reject(new Error(`Template file ${this.config.stepDefinitionsTemplate}.hbs does not exists`));
                            } else {
                                return reject(err2);
                            }
                        } else if (!stat.isFile()) {
                            return reject(new Error(`Template file ${this.config.stepDefinitionsTemplate}.hbs is not a file`));
                        }
                        return resolve();
                    });
                } else {
                    return resolve();
                }
            });
        });
    }

    protected async fetchTestPlanAndSections(): Promise<any> {
        this.testrailClient = new TestrailApiClient(this.config.testrail);

        this.plan = await this.testrailClient.getPlan(this.config.testrail.filters.plan_id);

        if (!this.plan.entries || this.plan.entries.length === 0 || !this.plan.entries[0].runs || this.plan.entries[0].runs.length === 0) {
            return Promise.reject('You must add Test Runs to your Test Plan in TestRail');
        }

        const cases = await this.testrailClient.getCases(this.plan.project_id, { suite_id: this.plan.entries[0].suite_id });
        this.caseSections = {};
        for (let i = 0; i < cases.length; i++) {
            const caseId = cases[i].id;
            this.caseSections[caseId] = cases[i].section_id;
        }
        const sections = await this.testrailClient.getSections(this.plan.project_id, { suite_id: this.plan.entries[0].suite_id });
        this.sectionTree = {};
        for (let i = 0; i < sections.length; i++) {
            const sectionId = sections[i].id;
            const node = {
                name: sections[i].name,
                slug: S(sections[i].name).slugify().s,
                parent_id: sections[i].parent_id
            };
            this.sectionTree[sectionId] = node;
        }

        return Promise.resolve();
    }

    protected async findImportedTestcases(): Promise<any> {
        this.testFiles = {};
        const re = /@tcid:(\d+)$/;

        return walk.sync(this.config.featuresDir, (filePath: string) => {
            if (/\.feature$/.test(filePath)) {
                const fileContent = fs.readFileSync(filePath).toString();

                const ids = fileContent.split('\n')
                                .filter((line: string) => re.test(line))
                                .map((line: string) => Number(re.exec(line)[1]));

                for (let i = 0; i < ids.length; i++) {
                    const id = ids[i];
                    this.testFiles[id] = filePath;
                }
            }
        });
    }

    protected async findImplementedStepDefinitions(): Promise<any> {
        this.implementedSteps = [];
        const re = /^this\.(Given|When|Then|defineStep)\((\/|')(.+)(\/|')(\w*)/;

        mkdirp.sync(this.config.stepDefinitionsDir);

        const foldersToScan = [
            path.resolve(this.config.stepDefinitionsDir),
            path.resolve(this.config.stepDefinitionsDir, '..', 'support')
        ];

        for (const folder of foldersToScan) {
            try {
                if (!fs.lstatSync(folder).isDirectory()) {
                    continue;
                }
            } catch (err) {
                continue;
            }

            walk.sync(folder, (filePath: string) => {
                if (!fs.lstatSync(filePath).isDirectory()) {
                    const fileContent = fs.readFileSync(filePath).toString();

                    const stepDefinitions = fileContent.split('\n').map(Function.prototype.call, String.prototype.trim)
                        .filter((line: string) => re.test(line))
                        .map((line: string) => {
                            const matches = re.exec(line);

                            const keyword = matches[1];
                            const patternInCode = matches[3];
                            let pattern = matches[3];
                            let isStringPattern = false;

                            // String Pattern
                            if (matches[2] === '\'') {
                              isStringPattern = true;
                              pattern = pattern.replace(/\$\w+/g, '<\\w+>');
                            }

                            const step: Step = {
                                filename: filePath.substr(folder.length + 1),
                                keyword,
                                regex: pattern,
                                pattern: patternInCode,
                                isStringPattern
                            };

                            if (matches[5].length) {
                              step.regexFlags = matches[5];
                            }

                            return step;
                        });

                    this.implementedSteps = this.implementedSteps.concat(stepDefinitions);
                }
            });
        }
    }

    /**
     * Gets the testcases from TestRail
     */
    protected async getTests(statuses?: any): Promise<any> {
        if (!statuses && this.config.testrail.filters.custom_status) {
            statuses = this.config.testrail.filters.custom_status;
        }

        let testcases: any[] = [];
        if (this.config.testrail.filters.run_id) {
            testcases = await this.testrailClient.getTests(this.config.testrail.filters.run_id);
        // all runs in a test plan
        } else {
            let uniqueCaseIds: number[] = [];
            for (const planentry of this.plan.entries) {
                for (const run of planentry.runs) {
                    const testcasesOfRun = await this.testrailClient.getTests(run.id);

                    const newTestcases = testcasesOfRun.filter((t: any) => uniqueCaseIds.indexOf(t.case_id) === -1);
                    testcases = testcases.concat(newTestcases);
                    uniqueCaseIds = uniqueCaseIds.concat(newTestcases.map((t: any) => t.case_id));
                }
            }
        }

        return testcases.filter((t: any) => !statuses || statuses.indexOf(t.custom_status) !== -1);
    }

    /**
     * Verify that each line is valid gherkin syntax
     */
    public isValidGherkin(gherkin: string): boolean {
        if (gherkin === null) {
            return false;
        }

        const lines = gherkin.split('\n')
            .map(Function.prototype.call, String.prototype.trim)
            .filter((line: string) => line.length > 0 && line.indexOf('Scenario:') !== 0);

        const re = new RegExp('^(Given|When|And|Then|Examples|\\||#)', 'i');
        const validLines = lines.filter((line: string) => re.test(line));

        let numLinesWithData = 0;
        let isData = false;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].substr(0, 3) === '"""') {
                numLinesWithData++;
                isData = !isData;
                continue;
            }
            if (isData) {
                numLinesWithData++;
                continue;
            }
        }

        return (lines.length === validLines.length + numLinesWithData);
    }

    /**
     * Split the gherkin content from TestRail into lines
     */
    public getGherkinLines(testcase: any): string[] {
        const arr = testcase.custom_gherkin.replace(/[\r]/g, '').split('\n').map(Function.prototype.call, String.prototype.trim)
          .map((line: string) => {
            // remove extra spaces
            // convert the first character to uppercase
            return line.replace(/^(Given|When|Then|And)\s+(\w)/i, (match: any, first: any, second: any) => {
              return first.charAt(0).toUpperCase() + first.slice(1) + ' ' + second.toUpperCase();
            });
          })
          .filter((line: string) => line.length > 0 && line.indexOf('Scenario:') !== 0)
          // replace line like: |:header1|:header2| by |header1|header2|
          .map((line: string) => {
            if (line[0] !== '|') {
                return line;
            }
            return line.replace(/\|:/g, '|');
          });

        // insert a blank line before Examples
        for (let i = arr.length - 1; i > 0; i--) {
            if (arr[i].indexOf('Examples') === 0) {
                arr.splice(i, 0, '');
            }
        }

        return this.replaceMultiPipesTables(arr);
    }

    protected replaceMultiPipesTables(arr: string[]): string[] {
        let tableStart = -1;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i][0] === '|' && i + 1 < arr.length) {
                if (tableStart === -1) {
                    tableStart = i;
                }
            } else if (tableStart !== -1) {
                let tableEnd = i;
                if (arr[i][0] === '|' && i + 1 === arr.length) {
                    tableEnd = tableEnd + 1;
                }

                // Replace tables like: ||value1|value2 by |value1|value2|
                // All rows of the table should start with ||'s - or ||| for the first one
                const len = tableEnd - tableStart;
                const multiPipesLines = arr.filter((value: string, index: Number): boolean => {
                    return index >= tableStart && index < tableEnd;
                }).filter((value: string): boolean => {
                    return value.substr(0, 2) === '||';
                }).length;

                if (len === multiPipesLines) {
                    arr.splice.apply(arr, (<any[]> [ tableStart, len ]).concat(
                         arr.filter((value: string, index: Number): boolean => {
                            return index >= tableStart && index < tableEnd;
                        }).map((line: string) => line.replace(/^(\|{2,})(.*)$/, '|$2|'))
                    ));
                }

                tableStart = -1;
            }
        }

        return arr;
    }

    /**
     * Gets the .feature file content based on a test case from TestRail
     */
    protected getFeatureFileContent(testcase: any, gherkin: string[]): string {
        let scenarioType = 'Scenario';
        if (gherkin.filter((line: string) => line.indexOf('Examples') !== -1).length > 0) {
            scenarioType = 'Scenario Outline';
        }

        let content = 'Feature: ' + this.getLastSectionName(testcase.case_id) + '\n';
        content += this.config.indent + '@tcid:' + testcase.case_id + '\n';
        content += this.config.indent + scenarioType + ': ' + testcase.title + '\n' + this.config.indent + this.config.indent;
        content += gherkin.join('\n' + this.config.indent + this.config.indent);

        return content;
    }

    /**
     * Find the name of the last-child section of a test case
     */
    protected getLastSectionName(testcaseId: number): string {
        if (!this.caseSections[testcaseId]) {
            return 'Cannot find feature name';
        }

        const sectionId = this.caseSections[testcaseId];

        const section = this.sectionTree[sectionId];

        return section.name;
    }

    /**
     * Gets relative path of where a testcase file should be located
     */
    protected getRelativePath(testcaseId: number): string {
        if (!this.caseSections[testcaseId] || this.config.directoryStructure === undefined) {
            return '';
        }

        const sectionId = this.caseSections[testcaseId];

        let section = this.sectionTree[sectionId];

        let paths: string[] = [];

        // tslint:disable-next-line:no-constant-condition
        while (true) {
            paths.push(this.config.directoryStructure.type === 'section:name' ? section.name : section.slug);

            if (section.parent_id === null) {
                break;
            }

            section = this.sectionTree[section.parent_id];
        }

        paths = paths.reverse();

        if (this.config.directoryStructure.skipRootFolder > 0) {
            paths = paths.splice(this.config.directoryStructure.skipRootFolder);
        }

        return paths.join('/');
    }

    protected escapeStringRegexp(str: string): string {
        const matchOperatorsRe = /[|\\{}()[\]^$+*?.]/g;
        return str.replace(matchOperatorsRe, '\\$&');
    }

    /**
     * Updates a test case gherkin content on TestRail
     */
    protected pushTestCaseToTestRail(testcase: any, gherkin: string): Promise<any> {
        const customGherkin = gherkin.split('\n')
            .slice(3)
            .map(Function.prototype.call, String.prototype.trim)
            .join('\n');

        return this.testrailClient.updateCase(testcase.case_id, { custom_gherkin: customGherkin });
    }

    protected showDiff(basename: string, oldStr: string, newStr: string): void {
        /* istanbul ignore next */
        if (process.env.SILENT === undefined || Boolean(process.env.SILENT) !== true) {
            console.log('  ' + chalk.yellow(`${basename} is not up to date with TestRail`));

            const diffs = jsdiff.diffLines(oldStr, newStr);

            diffs.forEach((part: any) => {
                const leadChar = (part.removed ? '-' : (part.added ? '+' : ' '));
                const lines = part.value.split('\n')
                                .map(Function.prototype.call, String.prototype.trim)
                                .filter((line: string) => line.length > 0);

                lines.forEach((line: any) => {
                    if (part.added) {
                        console.log(chalk.green(`${leadChar}${line}`));
                    } else if (part.removed) {
                        console.log(chalk.red(`${leadChar}${line}`));
                    } else {
                        console.log(`${leadChar}${line}`);
                    }
                });
            });

            console.log('');
        }
    }

    /**
     * Generate a file containing blank Steps Definitions
     */
     // tslint:disable-next-line:max-func-body-length
    protected getTestFileContent(gherkinSteps: string[], template: string): string {
        const templateContent = fs.readFileSync(path.resolve(this.templateDir, template + '.hbs'))
            .toString()
            .replace(/\t/g, this.config.indent);
        const compiledTemplate = Handlebars.compile(templateContent);

        const isScenarioOutline = gherkinSteps.filter((line: string) => line.indexOf('Examples') === 0).length > 0;

        const data: any = {};
        data.steps = [];
        let lastKeyword: string = null;
        let isData = false;

        const NUMBER_PATTERN = /\d+/gi;
        const NUMBER_MATCHING_GROUP = '(\\d+)';

        const QUOTED_STRING_PATTERN = /"[^"]*"/gi;
        const QUOTED_STRING_MATCHING_GROUP = '"([^"]*)"';

        const examples: any = {};
        if (isScenarioOutline) {
            let headerVars: any = {};
            // Find example values for each variables
            for (let j = 0; j < gherkinSteps.length; j++) {
                if (gherkinSteps[j].indexOf('Examples') === 0) {
                    headerVars = gherkinSteps[j + 1].trim().split('|')
                        .map(Function.prototype.call, String.prototype.trim);

                    for (let lineIndex = j + 2; lineIndex < gherkinSteps.length; lineIndex++) {
                        const exampleValues = gherkinSteps[lineIndex].trim().split('|')
                            .map(Function.prototype.call, String.prototype.trim);

                        for (let k = 0; k < headerVars.length; k++) {
                            if (examples[headerVars[k]] === undefined && exampleValues[k].length > 0) {
                                examples[headerVars[k]] = exampleValues[k];
                            }
                        }

                        if (Object.keys(examples).length === headerVars.length)   {
                            break;
                        }
                    }

                    break;
                }
            }
        }

        for (let i = 0; i < gherkinSteps.length; i++) {
            const gherkinsStep = gherkinSteps[i];
            // an example table or a comment
            if (gherkinsStep[0] === '|' || gherkinsStep[0] === '#') {
                continue;
            }
            // start/end of example data
            if (gherkinsStep.substr(0, 3) === '"""') {
                isData = !isData;
                continue;
            }
            // Scenario Outline
            if (gherkinsStep.length === 0 || gherkinsStep.indexOf('Examples') === 0) {
                continue;
            }
            if (isData) {
                continue;
            }

            const gherkinWords = gherkinsStep.split(' ');
            let keyword = gherkinWords.shift();
            let tableParam = '';

            if (i + 1 < gherkinSteps.length) {
                if (gherkinSteps[i + 1][0] === '|') { // an example table
                    tableParam = template === 'typescript.ts' ? 'table: any' : 'table';
                }
            }

            if (keyword === 'And') {
                keyword = lastKeyword;
            } else {
                lastKeyword = keyword;
            }

            let regex = gherkinWords.join(' ');

            const step: Step = <Step> { keyword: keyword, regex: regex, regexFlags: '' };
            // stepLine[0] will be something such as "I have <count> apples"
            const stepLine = [regex];

            // Replace <variable> by the values of data located in the examples table
            // stepLine[1] will be something such as "I have 10 apples"
            if (isScenarioOutline) {
                stepLine[1] = regex;
                let matchVar: any;
                do {
                    matchVar = /<(\w+)>/.exec(stepLine[1]);
                    if (matchVar) {
                        const varName = matchVar[1];
                        if (examples[varName] !== undefined) {
                            stepLine[1] = stepLine[1].substring(0, matchVar.index) +
                                examples[varName] +
                                stepLine[1].substring(matchVar.index + matchVar[0].length);
                        } else {
                            stepLine[1] = stepLine[1].substring(0, matchVar.index) +
                                'anything' +
                                stepLine[1].substring(matchVar.index + matchVar[0].length);
                        }
                    }
                } while (matchVar);
            }

            /* search if this step has already been implemented */
            let stepDefinitionMatch: Step = null;
            for (let m = 0; m < this.implementedSteps.length; m++) {
                const re = new RegExp(this.implementedSteps[m].regex, this.implementedSteps[m].regexFlags);

                if (stepLine.filter((line: string) => re.test(line)).length > 0) {
                    stepDefinitionMatch = this.implementedSteps[m];
                    break;
                }
            }

            if (stepDefinitionMatch === null) {
                let pattern: string = null;
                const params: string[] = [];

                if (this.config.stepDefinitionsStringPatterns) {
                    let match: any;
                    pattern = regex.replace(/\*/g, '\\*');

                    do {
                        match = /<(\w+)>/.exec(pattern);
                        if (match) {
                            pattern = pattern.substring(0, match.index) + '$' + match[1] + pattern.substring(match.index + match[0].length);

                            params.push(template === 'typescript.ts' ? match[1] + ': any' : match[1]);
                        }
                    } while (match);

                    pattern = '\'' + pattern + '\'';

                    step.regex = step.regex.replace(/\*/g, '\\*').replace(/<(\w+)>/g, '<\\w+>');
                } else {
                    regex = this.escapeStringRegexp(regex).replace(/\//g, '\\/');
                    // ------------
                    // add some pattern to our step definition
                    // code borrowed from lib/cucumber/support_code/step_definition_snippet_builder.js
                    step.regex = regex
                        .replace(QUOTED_STRING_PATTERN, QUOTED_STRING_MATCHING_GROUP)
                        .replace(NUMBER_PATTERN, NUMBER_MATCHING_GROUP);

                    const match1 = regex.match(QUOTED_STRING_MATCHING_GROUP);
                    const match2 = regex.replace(QUOTED_STRING_PATTERN, QUOTED_STRING_MATCHING_GROUP).match(NUMBER_MATCHING_GROUP);

                    let paramCount = match1 === null ? 0 : (match1.length - 1);
                    paramCount += match2 === null ? 0 : (match2.length - 1);

                    for (let n = 0; n < paramCount; n++) {
                      const argName = 'arg' + (n + 1);

                      params.push(template === 'typescript.ts' ? argName + ': string' : argName);
                    }

                    if (tableParam.length) {
                      params.push(tableParam);
                    }

                    step.regex = '^' + step.regex + '$';
                    pattern = '/' + step.regex + '/';
                }

                params.push(template === 'typescript.ts' ? 'callback: Function' : 'callback');

                // ------------

                step.isStringPattern = false;
                this.implementedSteps.push(step);
                data.steps.push({ keyword: keyword, pattern: pattern, params: params.join(', ') });
            }
        }

        if (data.steps.length === 0) {
            return null;
        }
        return compiledTemplate(data);
    }

    protected async verifySync(): Promise<any> {
        this.output(chalk.green('Verifying local features files against TestRail test cases ...'));
        this.output('');

        let statuses: any = undefined;
        if (this.config.testrail.verifyFilters) {
            if (this.config.testrail.verifyFilters.custom_status) {
                statuses = this.config.testrail.verifyFilters.custom_status;
            }
        }

        const testcases = await this.getTests(statuses);
        const errors: string[] = [];
        for (const testcase of testcases) {
            if (this.testFiles[testcase.case_id] === undefined) {
                errors.push(`"${testcase.title}" not found locally`);
                continue;
            }

            const gherkin = this.getGherkinLines(testcase);
            const remoteFileContent = this.getFeatureFileContent(testcase, gherkin);

            const featurePath = this.testFiles[testcase.case_id];
            const localFileContent = fs.readFileSync(featurePath).toString().trim();

            if (this.hasGherkinContentChanged(localFileContent, remoteFileContent, false)) {
                errors.push(`Local test case "${testcase.title}" is outdated`);
            }
        }

        return Promise.resolve(errors);
    }

    protected async findUnusedStepDefinitions(): Promise<any> {
        this.output(chalk.green('Searching for unused step definitions ...'));
        this.output('');

        this.testFiles = {};

        return new Promise((resolve, reject) => {
            let implementedSteps: Step[] = this.implementedSteps.map((s: any) => {
                s.used = false;
                return s;
            });

            walk.sync(this.config.featuresDir, (filePath: string) => {
                if (/\.feature$/.test(filePath)) {
                    const fileContent = fs.readFileSync(filePath).toString();

                    const re = new RegExp('^(Given|When|And|Then)', 'i');
                    const lines = fileContent.split('\n').map(Function.prototype.call, String.prototype.trim)
                                    .filter((line: string) => re.test(line));

                    for (let line of lines) {
                        const words = line.split(' ');
                        words.shift();
                        line = words.join(' ');

                        for (let m = 0; m < implementedSteps.length; m++) {
                            if (implementedSteps[m].used === true) {
                                continue;
                            }
                            const re = new RegExp(implementedSteps[m].regex, implementedSteps[m].regexFlags);
                            if (re.test(line)) {
                                implementedSteps[m].used = true;
                                break;
                            }
                        }
                    }

                    implementedSteps = implementedSteps.filter((s: any) => s.used === false);
                }
            });

            return resolve(
                implementedSteps.map((s: any) => {
                    return `Step "${s.pattern}" (${s.filename}) is not used`;
                })
            );
        });
    }

    protected async synchronizePlan(): Promise<any> {
        this.output(chalk.green('Syncing with TestRail ...'));
        this.output('');
        this.skippedCount = 0;

        const testcases = await this.getTests();
        for (const testcase of testcases) {
            /* istanbul ignore else: isValidGherkin function covered in unit test */
            if (this.isValidGherkin(testcase.custom_gherkin)) {
                await this.synchronizeCase(testcase, this.getRelativePath(testcase.case_id));
            } else {
                const slug = S(testcase.title).slugify().s;
                const log = `Invalid gherkin content for TestCase #${testcase.case_id}-${slug}`;
                this.output(chalk.yellow(log));
                this.output(chalk.yellow(testcase.custom_gherkin));
            }
        }

        if (this.skippedCount > 0) {
            const plural = this.skippedCount > 1 ? 's' : '';
            const log = `Skipped ${this.skippedCount} test case${plural} (no changes)`;
            this.output('  ' + chalk.yellow(log));
        }
    }

    protected async promptForConfirmation(message: string): Promise<boolean> {
        if (ScenarioSynchronizer.forcedPrompt !== undefined) {
            return Promise.resolve(ScenarioSynchronizer.forcedPrompt);
        }
        return inquirer.prompt({
            type: 'confirm',
            name: 'confirm',
            message,
            default: false
        }).then((answers: any) => {
            return Promise.resolve(answers.confirm);
        });
    }

    public static FORCE_CONFIRMATION_PROMPT(confirm: boolean): void {
        this.forcedPrompt = confirm;
    }

    protected hasGherkinContentChanged(fileContent1: string, fileContent2: string, considerScenarioNameChange: boolean): boolean {
        if (considerScenarioNameChange) {
            return fileContent1 !== fileContent2;
        }

        const gherkinContent1 = fileContent1.split('\n')
            .filter((line: string) => {
                return ! /^\s*(Feature: |@tcid:|Scenario( Outline)?: )/.test(line);
            })
            .join('\n');

        const gherkinContent2 = fileContent2.split('\n')
            .filter((line: string) => {
                return ! /^\s*(Feature: |@tcid:|Scenario( Outline)?: )/.test(line);
            })
            .join('\n');

        return gherkinContent1 !== gherkinContent2;
    }

    /**
     * Synchronize a test case from TestRail to the local filesystem
     */
    protected async synchronizeCase(testcase: any, relativePath: string): Promise<any> {
        const basename = S(testcase.title).slugify().s;
        const exists = (this.testFiles[testcase.case_id] !== undefined);

        let featurePath = path.resolve(this.config.featuresDir + '/' + relativePath, basename + '.feature');
        const stepDefinitionsExtension = this.config.stepDefinitionsTemplate ?
            path.extname(this.config.stepDefinitionsTemplate).substr(1) : '';
        let stepDefinitionsPath = path.resolve(
            this.config.stepDefinitionsDir + '/' + relativePath,
            basename + '.' + stepDefinitionsExtension
        );

        featurePath = await uniquefilename.get(featurePath, {});
        stepDefinitionsPath = await uniquefilename.get(stepDefinitionsPath, {});

        // If the testcase is not on the filesystem, create the desired directory structure
        if (!exists) {
            mkdirp.sync(this.config.featuresDir + '/' + relativePath);
        }

        const gherkin = this.getGherkinLines(testcase);
        const remoteFileContent = this.getFeatureFileContent(testcase, gherkin);

        if (!exists) {
            fs.writeFileSync(featurePath, remoteFileContent);

            if (this.config.stepDefinitionsTemplate) {
                const content = this.getTestFileContent(gherkin, this.config.stepDefinitionsTemplate);
                if (content !== null) {
                    mkdirp.sync(this.config.stepDefinitionsDir + '/' + relativePath);
                    fs.writeFileSync(stepDefinitionsPath, content);
                }
                this.output('  ' + chalk.green(`Creating ${basename}`));
            }
        } else {
            featurePath = this.testFiles[testcase.case_id];
            const localFileContent = fs.readFileSync(featurePath).toString().trim();
            const fileChanged = this.hasGherkinContentChanged(localFileContent, remoteFileContent, true);

            if (!fileChanged) {
                this.skippedCount = this.skippedCount + 1;
                return Promise.resolve();
            } else if (this.config.overwrite.local === true) {
                this.output('  ' + chalk.green(`Overwriting ${basename}`));
                fs.writeFileSync(featurePath, remoteFileContent);
                return Promise.resolve();
            } else if (this.config.overwrite.local === 'ask') {
                this.showDiff(basename, localFileContent, remoteFileContent);

                if (await this.promptForConfirmation('Do you want to overwrite the local version ?') === true) {
                    fs.writeFileSync(featurePath, remoteFileContent);
                    this.output('  ' + chalk.green(`Updated ${basename}`));
                } else {
                    this.output('  ' + chalk.yellow(`Skipping ${basename}`));
                }
            } else if (this.config.overwrite.remote === true) {
                this.output('  ' + chalk.green(`Pushing ${basename} to TestRail`));
                await this.pushTestCaseToTestRail(testcase, localFileContent);
            } else if (this.config.overwrite.remote === 'ask') {
                this.showDiff(basename, remoteFileContent, localFileContent);

                if (await this.promptForConfirmation('Do you want to override the TestRail version ?') === true) {
                    this.output('  ' + chalk.green(`Pushing ${basename} to TestRail`));
                    await this.pushTestCaseToTestRail(testcase, localFileContent);
                } else {
                    this.output('  ' + chalk.yellow(`Skipping ${basename}`));
                }
            } else {
                this.output('  ' + chalk.yellow(`Skipping ${basename}`));
                return Promise.resolve();
            }
        }
    }
}
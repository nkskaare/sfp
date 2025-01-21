import SfpCommand from '../../../SfpCommand';
import ProjectConfig from '../../../core/project/ProjectConfig';
import Git from '../../../core/git/Git';
import SFPLogger, {
    ConsoleLogger,
    Logger,
    LoggerLevel,
    COLOR_INFO,
    COLOR_SUCCESS,
    COLOR_KEY_MESSAGE,
    COLOR_WARNING,
    COLOR_HEADER,
    COLOR_ERROR,
} from '@flxbl-io/sfp-logger';
import { Flags } from '@oclif/core';
import { arrayFlagSfdxStyle, loglevel, logsgroupsymbol } from '../../../flags/sfdxflags';

import semver, { ReleaseType } from 'semver';
import chalk from 'chalk';

import Table from 'cli-table';
import { ZERO_BORDER_TABLE } from '../../../core/display/TableConstants';
import fs from 'fs-extra';
import { update } from 'lodash';

const NEXT_SUFFIX = '.NEXT';
const LATEST_SUFFIX = '.LATEST';

type VersionType = semver.ReleaseType | 'custom';

class VersionedPackage {
    packageName: string;
    packageId: string;
    path: string;

    currentVersion: string;
    newVersion: string = null;

    dependencies: VersionedPackage[] = [];

    constructor(
        packageName: string,
        versionNumber: string,
        dependencies: { package: string; versionNumber: string }[] = [],
        path: string = null
    ) {
        this.packageName = packageName;
        this.currentVersion = versionNumber;
        this.path = path;

        dependencies.forEach((dep) => {
            this.setDependency(dep.package, dep.versionNumber);
        });
    }

    public increment(versionType: VersionType = 'patch', customVersion: string = null): void {
        if ('custom' === versionType) {
            this.updateVersion(customVersion);
        }

        let cleanedVersion = this.versionByParts().join('.');
        this.updateVersion(semver.inc(cleanedVersion, versionType as ReleaseType));
    }

    public updateVersion(version: string): void {
        if (this.isUpdated) {
            return;
        }

        this.newVersion = version + this.getSuffix();
    }

    get isUpdated() {
        return this.newVersion !== null;
    }

    getSuffix(): string {
        if (this.currentVersion.includes(NEXT_SUFFIX)) {
            return NEXT_SUFFIX;
        }

        if (this.currentVersion.includes(LATEST_SUFFIX)) {
            return LATEST_SUFFIX;
        }

        return '.0';
    }

    /**
     * Remove any suffixes and build numbers from the version number
     * @returns cleaned version number without suffixes
     */
    versionByParts(rawVersion: string = this.currentVersion): string[] {
        let parts = rawVersion.split('.');
        return parts.slice(0, 3);
    }

    public setDependency(packageName: string, versionNumber: string): void {
        this.dependencies.push(new VersionedPackage(packageName, versionNumber));
    }

    public hasDependency(pkg: VersionedPackage): boolean {
        return this.getDependency(pkg) !== null;
    }

    public getDependency(pkg: VersionedPackage): VersionedPackage | null {
        if (!this.dependencies || this.dependencies.length === 0) {
            return null;
        }

        let dependency = this.dependencies.find((dep) => dep.packageName === pkg.packageName);

        return dependency ? dependency : null;
    }

    public updateDependency(parentPackage: VersionedPackage): void {
        let dependency = this.getDependency(parentPackage);

        if (dependency === null) {
            return;
        }

        if (dependency.isUpdated) {
            return;
        }

        dependency.updateVersion(parentPackage.newVersion);
    }

    public print(highlightFn = chalk.yellow.bold): string {
        if (!this.isUpdated) {
            return `${this.versionByParts().join('.')}`;
        }

        const oldParts = this.versionByParts();
        const newParts = this.versionByParts(this.newVersion);

        let formattedOld: string = oldParts
            .map((part, index) => {
                return part !== newParts[index] ? highlightFn(part) : part;
            })
            .join('.');
        let formattedNew: string = this.versionByParts(this.newVersion)
            .map((part, index) => {
                return part === oldParts[index] ? part : highlightFn(part);
            })
            .join('.');

        return `${formattedOld} -> ${formattedNew}`;
    }

    public write(): any {
        let updatedPackage : {
            packageName: string;
            versionNumber?: string;
            dependencies?: VersionedPackage[];
        } = { packageName: this.packageName };

        if (this.currentVersion === null || this.currentVersion === undefined) {
            return updatedPackage;
        }

        updatedPackage.versionNumber = this.currentVersion;

        if (this.isUpdated) {
            updatedPackage.versionNumber = this.newVersion;
        }

        if (this.dependencies.length > 0) {
            updatedPackage.dependencies = this.dependencies.map((dep) => dep.write());
        }

        return updatedPackage;
    }
}

export default class VersionUpdater extends SfpCommand {
    public static flags = {
        package: Flags.string({
            char: 'p',
            description: 'Specify the package to increment',
            required: false,
        }),
        all: Flags.boolean({
            char: 'a',
            description: 'Increment all package versions',
            required: false,
        }),
        targetref: Flags.string({
            description: 'Specify the git reference for diff comparison',
            required: false,
        }),
        targetorg: Flags.string({
            description: 'Specify the target org for diff comparison',
            required: false,
        }),
        patch: Flags.boolean({
            description: 'Increment patch number (default)',
            required: false,
        }),
        minor: Flags.boolean({
            char: 'm',
            description: 'Increment minor number',
            required: false,
        }),
        major: Flags.boolean({
            char: 'M',
            description: 'Increment major number',
            required: false,
        }),
        versionnumber: Flags.string({
            char: 'v',
            description: 'Set a custom version number',
            required: false,
        }),
        deps: Flags.boolean({
            description: 'Update direct dependencies',
            required: false,
        }),
        dryrun: Flags.boolean({
            description: 'Do not save changes to sfdx-project.json',
            required: false,
            default: false,
        }),
        json: Flags.boolean({
            description: 'Output JSON report',
            required: false,
        }),
        logsgroupsymbol,
        loglevel,
    };

    projectData: any;
    projectPackages: Map<string, VersionedPackage>;

    diffChecker: PackageDiff;

    async execute(): Promise<any> {
        let logger: Logger = new ConsoleLogger();

        // SFPLogger.log(COLOR_HEADER(`Target Ref: ${this.flags.targetref}`), LoggerLevel.INFO, logger);
        SFPLogger.printHeaderLine('', COLOR_HEADER, LoggerLevel.INFO);

        this.loadProjectData();
        await this.updateVersions();

        if (!this.flags.dryRun) {
            await this.save();
        }
    }

    getVersionType(): VersionType {
        if (this.flags.minor) {
            return 'minor';
        }

        if (this.flags.major) {
            return 'major';
        }

        if (this.flags.versionnumber) {
            return 'custom';
        }

        return 'patch';
    }

    loadProjectData() {
        this.projectData = ProjectConfig.getSFDXProjectConfig(null);

        this.projectPackages = new Map(
            this.projectData.packageDirectories.map(
                (pkg: {
                    package: string;
                    versionNumber: string;
                    dependencies?: { package: string; versionNumber: string }[];
                    path: string
                }) => [pkg.package, new VersionedPackage(pkg.package, pkg.versionNumber, pkg.dependencies, pkg.path)]
            )
        );
    }

    private async updateVersions(): Promise<void> {
        let updatedPackages = await this.getDiffChecker().getUpdatedPackages();

        updatedPackages.forEach((pkg) => {
            pkg.increment(this.getVersionType(), this.flags.versionnumber);
        });

        const updatedDependencies = this.updateDependencies(updatedPackages, { deps: this.flags.deps });

        if (this.flags.json) {
            console.log(JSON.stringify({ updatedPackages, updatedDependencies }, null, 2));
            return;
        }

        new ReportGenerator(updatedPackages, updatedDependencies).printReport();
    }

    public getDiffChecker(): PackageDiff {
        let diffChecker: PackageDiff = null;

        if (this.flags.targetref) {
            diffChecker = new GitDiff(this.flags.targetref, Array.from(this.projectPackages.values()));
        } else if (this.flags.targetorg) {
            diffChecker = new OrgDiff(this.flags.targetOrg, Array.from(this.projectPackages.values()));
        } else if (this.flags.package) {
            diffChecker = new SinglePackageDiff(this.flags.package, Array.from(this.projectPackages.values()));
        } else if (this.flags.all) {
            diffChecker = new AllPackageDiff(Array.from(this.projectPackages.values()));
        }

        if (!diffChecker) {
            console.error(chalk.red('Please specify --package, --all, or --target-ref.'));
            process.exit(1);
        }

        return diffChecker;
    }

    // Get package by name
    public getPackage(packageName: string): VersionedPackage {
        return this.projectPackages.get(packageName);
    }

    public updateDependencies(updatedPackages: VersionedPackage[], options = { deps: false }): VersionedPackage[] {
        let updatedDependencies: VersionedPackage[] = [];

        for (const updatedPackage of updatedPackages) {
            this.projectPackages.forEach((projectPackage) => {
                let dependency = projectPackage.getDependency(updatedPackage);

                if (dependency === null) {
                    return;
                }

                if (!dependency.isUpdated) {
                    dependency.updateVersion(updatedPackage.newVersion);
                }

                if (options.deps) {
                    projectPackage.increment();
                }

                updatedDependencies.push(projectPackage);
            });
        }

        return updatedDependencies;
    }

    public async save() {
        const projectPackages = Array.from(this.projectPackages.values());

        this.projectData.packageDirectories = this.projectData.packageDirectories.map((pkg) => {
            const updatedPkg = projectPackages.find((projectPackage) => projectPackage.packageName === pkg.package);
            return updatedPkg ? { ...pkg, ...updatedPkg.write() } : pkg;
        });

        // Save the updated project data back to sfdx-project.json
        const projectConfigPath = 'sfdx-project.json';
        fs.writeFileSync(projectConfigPath, JSON.stringify(this.projectData, null, 2));

        SFPLogger.log(COLOR_SUCCESS(`\nsfdx-project.json updated successfully!`), LoggerLevel.INFO);

    }
}

interface PackageDiff {
    getUpdatedPackages(): Promise<VersionedPackage[]>;
}

class GitDiff implements PackageDiff {
    targetRef: string;
    projectPackages: VersionedPackage[];

    constructor(targetRef: string, projectPackages: VersionedPackage[]) {
        this.targetRef = targetRef;
        this.projectPackages = projectPackages;
    }

    async getUpdatedPackages(): Promise<VersionedPackage[]> {
        try {
            let git: Git = await Git.initiateRepo();
            const changedFiles = await git.diff(['--name-only', this.targetRef]);

            const updatedPackages: VersionedPackage[] = this.projectPackages
                .filter((pkg) => changedFiles.some((file) => file.startsWith(pkg.path.replace(/^\.\//, ''))));

            SFPLogger.log(COLOR_INFO(`\nPackages updated based on git diff against `) + chalk.yellow(chalk.bold(`${this.targetRef}:`)), LoggerLevel.INFO);
            return updatedPackages;
        } catch (error) {
            SFPLogger.log(COLOR_ERROR(`Error running git diff: ${error.message}`), LoggerLevel.ERROR);
            return [];
        }
    }
}

class OrgDiff implements PackageDiff {
    targetOrg: string;
    projectPackages: VersionedPackage[];

    constructor(targetOrg: string, projectPackages: VersionedPackage[]) {
        this.targetOrg = targetOrg;
        this.projectPackages = projectPackages;
    }

    async getUpdatedPackages(): Promise<VersionedPackage[]> {
        try {
            const installedPackages = []; //JSON.parse(
            //     execSync(`sf package installed list -o ${this.targetOrg} --json`, {
            //         encoding: 'utf-8',
            //     })
            // ).result;

            // iterate over installed packages and compare with projectPackages
            const updatedPackages = this.projectPackages
                .filter((pkg) =>
                    installedPackages.some(
                        (installedPkg) =>
                            installedPkg.SubscriberPackageName === pkg.packageName &&
                            semver.lte(
                                semver.coerce(pkg.currentVersion),
                                semver.coerce(installedPkg.SubscriberPackageVersionNumber)
                            )
                    )
                );

            SFPLogger.log(COLOR_INFO(`\nPackages updated based on org diff against `) + chalk.yellow(chalk.bold(`${this.targetOrg}`)), LoggerLevel.INFO);
            return updatedPackages;
        } catch (error) {
            SFPLogger.log(COLOR_ERROR(`Error running org diff: ${error.message}`), LoggerLevel.ERROR);
            return [];
        }
    }
}

class SinglePackageDiff implements PackageDiff {
    packageName: string;
    projectPackages: VersionedPackage[];

    constructor(packageName: string, projectPackages: VersionedPackage[]) {
        this.packageName = packageName;
        this.projectPackages = projectPackages;
    }

    async getUpdatedPackages(): Promise<VersionedPackage[]> {
        const pkg = this.projectPackages.find((pkg) => pkg.packageName === this.packageName);
        return pkg ? [pkg] : [];
    }
}

class AllPackageDiff implements PackageDiff {
    projectPackages: VersionedPackage[];

    constructor(projectPackages: VersionedPackage[]) {
        this.projectPackages = projectPackages;
    }

    async getUpdatedPackages(): Promise<VersionedPackage[]> {
        return this.projectPackages;
    }
}

class ReportGenerator {
    format: string = 'human';
    updatedPackages: VersionedPackage[] = [];
    updatedDependencies: VersionedPackage[] = [];

    _arrow: string = '⮑';

    table: Table;
    dependenciesTable: Table;

    constructor(updatedPackages: VersionedPackage[] = [], updatedDependencies: VersionedPackage[] = []) {
        this.setUpdatedPackages(updatedPackages);
        this.setUpdatedDependencies(updatedDependencies);
    }

    public setUpdatedPackages(updatedPackages: VersionedPackage[]) {
        this.updatedPackages = updatedPackages;
    }

    public setUpdatedDependencies(updatedDependencies: VersionedPackage[]) {
        this.updatedDependencies = updatedDependencies;
    }

    public printUpdatedPackages(): void {
        SFPLogger.log(COLOR_KEY_MESSAGE(`\nPackage versions updated:`), LoggerLevel.INFO);
        this.updatedPackages.forEach((pkg) => {
            this.table.push([pkg.packageName, pkg.print()]);
        });

        SFPLogger.log(this.table.toString(), LoggerLevel.INFO);
    }

    public printUpdatedDependencies(): void {
        if (this.updatedDependencies.length <= 0) {
            return;
        }

        SFPLogger.log(COLOR_KEY_MESSAGE(`\nDependencies updated:`), LoggerLevel.INFO);

        this.updatedDependencies.forEach((pkg) => {

            this.dependenciesTable.push([pkg.packageName, pkg.print()]);

            pkg.dependencies.forEach((dependency) => {
                if (!dependency.isUpdated) {
                    return;
                }

                this.dependenciesTable.push([chalk.gray(` ${this._arrow}  ${dependency.packageName}`), chalk.gray(dependency.print(chalk.cyan.bold))]);            
            });

        });
        SFPLogger.log(this.dependenciesTable.toString(), LoggerLevel.INFO);
    }

    public printReport() {

        this.table = new Table({
            head: ['Package', 'Version'],
            chars: ZERO_BORDER_TABLE
        })

        this.dependenciesTable = new Table({
            head: ['Package', 'Version'],
            chars: ZERO_BORDER_TABLE
        })

        this.printUpdatedPackages();
        this.printUpdatedDependencies();
    }
}

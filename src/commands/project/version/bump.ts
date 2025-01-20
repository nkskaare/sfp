import SfpCommand from '../../../SfpCommand';
import ProjectConfig from '../../../core/project/ProjectConfig';
import Git from '../../../core/git/Git';
import SFPLogger, {
    ConsoleLogger,
    Logger,
    LoggerLevel,
    COLOR_KEY_MESSAGE,
    COLOR_WARNING,
    COLOR_HEADER,
} from '@flxbl-io/sfp-logger';
import { Flags } from '@oclif/core';
import { arrayFlagSfdxStyle, loglevel, logsgroupsymbol } from '../../../flags/sfdxflags';

import semver, { ReleaseType } from 'semver';
import chalk from 'chalk';
import SourceToMDAPIConvertor from '../../../core/package/packageFormatConvertors/SourceToMDAPIConvertor';
import { Package2Fields } from '@salesforce/packaging';

const NEXT_SUFFIX = '.NEXT';
const LATEST_SUFFIX = '.LATEST';

type VersionType = semver.ReleaseType | 'custom';

class VersionedPackage {
    packageName: string;
    packageId: string;

    currentVersion: string;
    newVersion: string = null;

    dependencies: VersionedPackage[] = [];

    constructor(
        packageName: string,
        versionNumber: string,
        dependencies: { package: string; versionNumber: string }[] = []
    ) {
        this.packageName = packageName;
        this.currentVersion = versionNumber;

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

    public updateVersion(version: string) : void {
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

    public getDependency(pkg: VersionedPackage): VersionedPackage {
        if (!this.dependencies || this.dependencies.length === 0) {
            return null;
        }

        return this.dependencies.find((dep) => dep.packageName === pkg.packageName);
    }

    public updateDependency(parentPackage: VersionedPackage): void {
        let dependency = this.getDependency(parentPackage);

        if (dependency === null || dependency === undefined) {
            return;
        }

        if (dependency.isUpdated) {
            return;
        }

        dependency.updateVersion(parentPackage.newVersion);
    }

    public print(colorFn = chalk.yellow): string {
        if (!this.isUpdated) {
            return colorFn(`${this.packageName}: ${this.versionByParts().join('.')}`);
        }

        const oldParts = this.versionByParts();
        const newParts = this.versionByParts(this.newVersion);

        let formattedOld: string = oldParts
            .map((part, index) => {
                return part !== newParts[index] ? chalk.bold(part) : part;
            })
            .join('.');
        let formattedNew: string = this.versionByParts(this.newVersion)
            .map((part, index) => {
                return part === oldParts[index] ? part : chalk.bold(part);
            })
            .join('.');

        return colorFn(`${this.packageName}: ${formattedOld} -> ${formattedNew}`);
    }

    public write() {
        if (!this.isUpdated) {
            return;
        }

        if (this.dependencies.length > 0) {
            return {
                package: this.packageName,
                versionNumber: this.newVersion,
                dependencies: this.dependencies.map((dep) => {
                    dep.write();
                }),
            };
        }

        return {
            package: this.packageName,
            versionNumber: this.newVersion,
        };
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
        }),
        json: Flags.boolean({
            description: 'Output JSON report',
            required: false,
        }),
        logsgroupsymbol,
        loglevel,
    };

    packages: Map<string, VersionedPackage>;
    diffChecker: PackageDiff;

    projectData: any;

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

        this.packages = new Map(
            this.projectData.packageDirectories.map(
                (pkg: {
                    package: string;
                    versionNumber: string;
                    dependencies?: { package: string; versionNumber: string }[];
                }) => [pkg.package, new VersionedPackage(pkg.package, pkg.versionNumber, pkg.dependencies)]
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
            diffChecker = new GitDiff(this.flags.targetref, this.projectData);
        } else if (this.flags.targetorg) {
            diffChecker = new OrgDiff(this.flags.targetOrg, this.projectData);
        } else if (this.flags.package) {
            diffChecker = new SinglePackageDiff(this.flags.package, this.projectData);
        } else if (this.flags.all) {
            diffChecker = new AllPackageDiff(this.projectData);
        }

        if (!diffChecker) {
            console.error(chalk.red('Please specify --package, --all, or --target-ref.'));
            process.exit(1);
        }

        return diffChecker;
    }

    // Get package by name
    public getPackage(packageName: string): VersionedPackage {
        return this.packages.get(packageName);
    }

    public updateDependencies(updatedPackages: VersionedPackage[], options = { deps: false }): VersionedPackage[] {
        let updatedDependencies: VersionedPackage[] = [];

        for (const updatedPackage of updatedPackages) {
            this.packages.forEach((projectPackage) => {
                projectPackage.updateDependency(updatedPackage);

                if (options.deps) {
                    projectPackage.increment();
                }

                updatedDependencies.push(projectPackage);
            });
        }

        return updatedDependencies;
    }

    public async save() {
        // fs.writeFileSync('.', JSON.stringify(this.projectData, null, 2));
        console.log(chalk.green(`\nsfdx-project.json updated successfully!`));
    }
}

interface PackageDiff {
    getUpdatedPackages(): Promise<VersionedPackage[]>;
}

class GitDiff implements PackageDiff {
    targetRef: string;
    projectData: any;

    constructor(targetRef: string, projectData: any) {
        this.targetRef = targetRef;
        this.projectData = projectData;
    }

    async getUpdatedPackages(): Promise<VersionedPackage[]> {
        try {
            let git: Git = await Git.initiateRepo();

            const changedFiles = await git.diff(['--name-only', this.targetRef]);

            console.log('debug >> Changed files:', changedFiles);
            const updatedPackages: VersionedPackage[] = this.projectData.packageDirectories
                .filter((pkg) => changedFiles.some((file) => file.startsWith(pkg.path.replace(/^\.\//, ''))))
                .map((pkg) => new VersionedPackage(pkg.packageName, pkg.versionNumber, pkg.dependencies));

            console.log(chalk.blue(`\nPackages updated based on git diff with ${this.targetRef}`));
            return updatedPackages;
        } catch (error) {
            console.error(chalk.red(`Error running git diff: ${error.message}`));
            return [];
        }
    }
}

class OrgDiff implements PackageDiff {
    targetOrg: string;
    projectData: any;

    constructor(targetOrg: string, projectData: any) {
        this.targetOrg = targetOrg;
        this.projectData = projectData;
    }

    async getUpdatedPackages(): Promise<VersionedPackage[]> {
        try {
            const installedPackages = []; //JSON.parse(
            //     execSync(`sf package installed list -o ${this.targetOrg} --json`, {
            //         encoding: 'utf-8',
            //     })
            // ).result;

            // iterate over installed packages and compare with projectData
            const updatedPackages = this.projectData.packageDirectories
                .filter((pkg) =>
                    installedPackages.some(
                        (installedPkg) =>
                            installedPkg.SubscriberPackageName === pkg.package &&
                            semver.lte(
                                semver.coerce(pkg.versionNumber),
                                semver.coerce(installedPkg.SubscriberPackageVersionNumber)
                            )
                    )
                )
                .map((pkg) => new VersionedPackage(pkg.packageName, pkg.versionNumber, pkg.dependencies));

            console.log(chalk.blue(`\nPackages updated based on org diff with ${this.targetOrg}`));
            return updatedPackages;
        } catch (error) {
            console.error(chalk.red(`Error running org diff: ${error.message}`));
            return [];
        }
    }
}

class SinglePackageDiff implements PackageDiff {
    packageName: string;
    projectData: any;

    constructor(packageName: string, projectData: any) {
        this.packageName = packageName;
        this.projectData = projectData;
    }

    async getUpdatedPackages(): Promise<VersionedPackage[]> {
        const pkg = this.projectData.packageDirectories.find(
            (pkg: { package: string }) => pkg.package === this.packageName
        );
        return [new VersionedPackage(pkg.package, pkg.versionNumber, pkg.dependencies)];
    }
}

class AllPackageDiff implements PackageDiff {
    projectData: any;

    constructor(projectData: any) {
        this.projectData = projectData;
    }

    async getUpdatedPackages(): Promise<VersionedPackage[]> {
        return this.projectData.packageDirectories.map(
            (pkg) => new VersionedPackage(pkg.package, pkg.versionNumber, pkg.dependencies)
        );
    }
}

class ReportGenerator {
    format: string = 'human';
    updatedPackages: VersionedPackage[] = [];
    updatedDependencies: VersionedPackage[] = [];

    arrow: string = '⮑';

    defaultColorFn = chalk.yellow;

    paddedLength: number = 4;

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
        this.paddedLength = Math.max(...this.updatedPackages.map((pkg) => pkg.packageName.length));

        console.log(chalk.blue(`\nPackage versions updated:`));
        this.updatedPackages.forEach((pkg) => {
            const paddedName = pkg.packageName.padEnd(this.paddedLength, ' ');
            console.log(`  ${paddedName} : ${pkg.print()}`);
        });
    }

    public printUpdatedDependencies(): void {
        if (this.updatedDependencies.length <= 0) {
            return;
        }

        console.log(chalk.blue(`\nDependencies updated:`));

        this.updatedDependencies.forEach((dep) => {
            console.log(`\n${dep.print()}`);
            dep.dependencies.forEach((d) => {
                console.log(chalk.gray(`  ${this.arrow} ${d.print()}`));
            });
        });
        console.log(`\n`);
    }

    // Generate report
    public printReport() {
        this.printUpdatedPackages();
        this.printUpdatedDependencies();
    }
}

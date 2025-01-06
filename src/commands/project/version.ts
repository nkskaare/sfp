import SfpCommand from '../../SfpCommand';
import ProjectConfig from '../../core/project/ProjectConfig';
import SFPLogger, {
    ConsoleLogger,
    Logger,
    LoggerLevel,
    COLOR_KEY_MESSAGE,
    COLOR_WARNING,
    COLOR_HEADER,
} from '@flxbl-io/sfp-logger';
import { Flags } from '@oclif/core';
import { arrayFlagSfdxStyle, loglevel, logsgroupsymbol } from '../../flags/sfdxflags';
import { Logger } from '@salesforce/core';
import { Logger } from '@oclif/core/lib/errors';
import SfpPackage from '../../core/package/SfpPackage';

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




    async execute(): Promise<any> {
        let logger: Logger = new ConsoleLogger();

        SFPLogger.log(COLOR_HEADER(`Target Ref: ${this.flags.targetref}`), LoggerLevel.INFO, logger);
        SFPLogger.printHeaderLine('', COLOR_HEADER, LoggerLevel.INFO);


        console.log(ProjectConfig.getAllPackages(null));

        this.updateVersions();
    }

        // Main public to execute version update logic
    private updateVersions() {
        
        let projectDescriptor = ProjectConfig.getSFDXProjectConfig(null);
    
        let updatedPackages = [];
    
        if (this.flags.targetref) {
        updatedPackages = getUpdatedPackagesFromGitDiff(targetRef).map((pkg) =>
            incrementPackageVersion(pkg.package, versionType)
        );
        } else if (this.flags.targetorg) {
        updatedPackages = getUpdatedPackagesFromOrgDiff(targetOrg).map((pkg) =>
            incrementPackageVersion(pkg.package, versionType)
        );
        } else if (this.flags.package) {
        updatedPackages.push(
            incrementPackageVersion(packageName, versionType, versionNumber)
        );
        } else if (all) {
        updatedPackages = projectData.packageDirectories.map((pkg) =>
            incrementPackageVersion(pkg.package, versionType)
        );
        } else {
        console.error(
            chalk.red("Please specify --package, --all, or --target-ref.")
        );
        process.exit(1);
        }
    
        const dependenciesUpdated = updateDependencies(updatedPackages, { deps });
    
        if (!dryRun) {
            this.save();
        }
    
        if (jsonOutput) {
            console.log(
                JSON.stringify({ updatedPackages, dependenciesUpdated }, null, 2)
            );
        return;
        }
    
        generateHumanReadableReport(updatedPackages, dependenciesUpdated);
    }

    
    // Save the updated project data to file
    public save() {
        fs.writeFileSync(projectPath, JSON.stringify(projectData, null, 2));
        console.log(chalk.green(`\nsfdx-project.json updated successfully!`));
    }
    
    // Get package by name
    public getPackageByName(packageName) {
        return projectData.packageDirectories.find(
        (pkg) => pkg.package === packageName
        );
    }
    
    // --- Version update publics ---
    
    // Update version number based on type
    public updateVersionNumber(version, type, customVersion) {
        if (customVersion) return customVersion;
        switch (type) {
        case "major":
            return semver.inc(version, "major");
        case "minor":
            return semver.inc(version, "minor");
        case "patch":
        default:
            return semver.inc(version, "patch");
        }
    }
    
    // Increment package version
    public incrementPackageVersion(packageName, versionType, customVersion) {
        const pkg = getPackageByName(packageName);
        if (!pkg) {
        console.error(chalk.red(`Package ${packageName} not found.`));
        process.exit(1);
        }
    
        const oldVersion = stripSuffixAndBuildNumber(pkg.versionNumber || "");
        const newVersion =
        customVersion || updateVersionNumber(oldVersion, versionType);
        pkg.versionNumber =
        newVersion + (pkg.versionNumber.includes(".NEXT") ? ".NEXT" : ".0");
    
        return { package: packageName, oldVersion, newVersion };
    }
    
    // Utility public to strip suffixes and build number for internal comparisons
    private static stripSuffixAndBuildNumber(version) {
        const parts = version.split(".");
        if (["NEXT", "LATEST"].includes(parts[parts.length - 1])) parts.pop();
        if (parts.length === 4 && !isNaN(parts[3])) parts.pop();
        return parts.join(".");
    }
    
    // Get updated packages based on Git diff
    public getUpdatedPackagesFromGitDiff(targetRef) {
        try {
        const changedFiles = execSync(`git diff --name-only ${targetRef}`, {
            encoding: "utf-8"
        })
            .split("\n")
            .filter((file) => file.trim() !== "");
    
        const updatedPackages = projectData.packageDirectories
            .filter((pkg) =>
            changedFiles.some((file) =>
                file.startsWith(pkg.path.replace(/^\.\//, ""))
            )
            )
            .map((pkg) => ({
            package: pkg.package,
            oldVersion: stripSuffixAndBuildNumber(pkg.versionNumber),
            newVersion: null
            }));
    
        console.log(
            chalk.blue(`\nPackages updated based on git diff with ${targetRef}`)
        );
        return updatedPackages;
        } catch (error) {
        console.error(chalk.red(`Error running git diff: ${error.message}`));
        return [];
        }
    }
    
    public getUpdatedPackagesFromOrgDiff(targetOrg) {
        try {
        const installedPackages = JSON.parse(
            execSync(`sf package installed list -o ${targetOrg} --json`, {
            encoding: "utf-8"
            })
        ).result;
    
        // iterate over installed packages and compare with projectData
        const updatedPackages = projectData.packageDirectories
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
            .map((pkg) => ({
            package: pkg.package,
            oldVersion: stripSuffixAndBuildNumber(pkg.versionNumber),
            newVersion: null
            }));
    
        console.log(
            chalk.blue(`\nPackages updated based on org diff with ${targetOrg}`)
        );
        return updatedPackages;
        } catch (error) {
        console.error(chalk.red(`Error running org diff: ${error.message}`));
        return [];
        }
    }
    
    // Check if a package's dependencies include an updated package
    public hasDependencyChanged(pkg, parentPackage, newVersion) {
        if (!pkg.dependencies) return false;
        return pkg.dependencies.some(
        (dep) =>
            dep.package === parentPackage &&
            stripSuffixAndBuildNumber(dep.versionNumber) !== newVersion
        );
    }
    
    // Main dependency update public
    public updateDependencies(updatedPackages, options = {}) {
        const { deps = false } = options;
        const processedPackages = new Map(
        updatedPackages.map((pkg) => [
            pkg.package,
            {
            package: pkg.package,
            oldVersion: pkg.oldVersion,
            newVersion: pkg.newVersion,
            dependencies: [],
            isDirectUpdate: true
            }
        ])
        );
    
        for (const {
        package: parentPackage,
        newVersion,
        oldVersion
        } of updatedPackages) {
        for (const pkg of projectData.packageDirectories) {
            if (!pkg.dependencies) continue;
            if (!hasDependencyChanged(pkg, parentPackage, newVersion)) continue;
    
            const dependencyCause = {
            package: parentPackage,
            oldVersion: oldVersion,
            newVersion: newVersion
            };
    
            if (processedPackages.has(pkg.package)) {
            processedPackages.get(pkg.package).dependencies.push(dependencyCause);
            continue;
            }
    
            updateDependencyVersion(pkg, parentPackage, newVersion);
            // If deps is true, increment version of the dependent package
            let processedPackage = {
            package: pkg.package,
            oldVersion: stripSuffixAndBuildNumber(pkg.versionNumber || ""),
            newVersion: null,
            dependencies: [dependencyCause],
            isDirectUpdate: false
            };
    
            if (deps)
            processedPackage.newVersion = incrementPackageVersion(
                pkg.package,
                "patch"
            ).newVersion;
    
            processedPackages.set(pkg.package, processedPackage);
        }
        }
        return Array.from(processedPackages.values());
    }
    
    public updateDependencyVersion(pkg, parentPackage, newVersion) {
        pkg.dependencies.forEach((dep) => {
        if (dep.package === parentPackage) {
            dep.versionNumber = newVersion + ".LATEST";
        }
        });
    }
    
    // --- Printing publics ---
    
    // Improved version update formatting
    public formatVersionUpdate(oldVersion, newVersion, colorFn = chalk.yellow) {
        const oldParts = stripSuffixAndBuildNumber(oldVersion).split(".");
        const newParts = newVersion
        ? stripSuffixAndBuildNumber(newVersion).split(".")
        : null;
        let formattedOld = "",
        formattedNew = "";
    
        oldParts.forEach((part, index) => {
        formattedOld +=
            newParts && part !== newParts[index] ? chalk.bold(part) : part;
        formattedOld += index < oldParts.length - 1 ? "." : "";
        });
    
        if (newParts) {
        newParts.forEach((part, index) => {
            formattedNew +=
            part === oldParts[index] ? part : chalk.bold(colorFn(part));
            formattedNew += index < newParts.length - 1 ? "." : "";
        });
        }
    
        return `${formattedOld} ${formattedNew ? "-> " + formattedNew : ""}`;
    }
    
    // Print package updates
    public printUpdatedPackages(updatedPackages) {
        const maxNameLength = Math.max(
        ...updatedPackages.map((pkg) => pkg.package.length)
        );
        console.log(chalk.blue(`\nPackage versions updated:`));
        updatedPackages.forEach((pkg) => {
        const paddedName = pkg.package.padEnd(maxNameLength, " ");
        console.log(
            `  ${paddedName} : ${formatVersionUpdate(pkg.oldVersion, pkg.newVersion)}`
        );
        });
    }
    
    // Print dependencies
    public printUpdatedDependencies(dependenciesUpdated) {
        const dependencies = dependenciesUpdated.filter(
        (pkg) => !pkg.isDirectUpdate && pkg.dependencies.length > 0
        );
    
        if (dependencies.length > 0) {
        console.log(chalk.blue(`\nDependencies updated:`));
        dependencies.forEach((dep) => {
            console.log(
            `\n${dep.package}: ${formatVersionUpdate(dep.oldVersion, dep.newVersion)}`
            );
            dep.dependencies.forEach((d) => {
            console.log(
                chalk.gray(
                `  ⮑ ${d.package}: ${formatVersionUpdate(d.oldVersion, d.newVersion, (colorFn = chalk.gray))}`
                )
            );
            });
        });
        console.log(`\n`);
        }
    }
    
    // Generate report
    public generateHumanReadableReport(updatedPackages, dependenciesUpdated) {
        printUpdatedPackages(updatedPackages);
        printUpdatedDependencies(dependenciesUpdated);
    }


}

// [name, task, isCoreTask]. Core tasks are the ones needed to sync without the UI.
export type StartupTask = [string, ()=> Promise<void>, boolean];

type RunTask = (name: string, task: ()=> Promise<void>)=> Promise<void>;

// A background sync task can initialise the app before the UI starts in the same JS runtime. Runs are
// serialised, and tasks already completed by an earlier run are skipped so the database and settings are
// only loaded once.
const createStartupTaskRunner = (runTask: RunTask) => {
	const completedTasks = new Set<string>();
	let lastRun: Promise<void> = Promise.resolve();

	const run = async (tasks: StartupTask[], coreTasksOnly: boolean) => {
		for (const [name, task, isCoreTask] of tasks) {
			if (completedTasks.has(name) || (coreTasksOnly && !isCoreTask)) continue;

			try {
				await runTask(name, task);
			} catch (error) {
				// Later tasks depend on state set up by earlier tasks in the same run, so start over next time.
				completedTasks.clear();
				throw error;
			}
			completedTasks.add(name);
		}
	};

	return (buildTasks: ()=> StartupTask[], coreTasksOnly: boolean) => {
		const previousRun = lastRun;
		lastRun = (async () => {
			try {
				await previousRun;
			} catch (_error) {
				// Already reported to the caller of the previous run
			}
			await run(buildTasks(), coreTasksOnly);
		})();
		return lastRun;
	};
};

export default createStartupTaskRunner;

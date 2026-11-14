import createStartupTaskRunner, { StartupTask } from './createStartupTaskRunner';

const setUp = (failingTask: string|null = null) => {
	const ran: string[] = [];
	const runner = createStartupTaskRunner(async (_name, task) => task());
	const buildTasks = () => (): StartupTask[] => [
		['core1', async () => { ran.push('core1'); }, true],
		['ui1', async () => {
			if (failingTask === 'ui1') throw new Error('ui1 failed');
			ran.push('ui1');
		}, false],
		['core2', async () => { ran.push('core2'); }, true],
	];
	return { ran, runner, buildTasks };
};

describe('createStartupTaskRunner', () => {
	test('should run only core tasks, then only the remaining tasks on a full run', async () => {
		const { ran, runner, buildTasks } = setUp();
		await runner(buildTasks(), true);
		expect(ran).toEqual(['core1', 'core2']);
		await runner(buildTasks(), false);
		expect(ran).toEqual(['core1', 'core2', 'ui1']);
	});

	test('should not start a run until the previous one has finished', async () => {
		const { ran, runner, buildTasks } = setUp();
		const coreRun = runner(buildTasks(), true);
		const fullRun = runner(buildTasks(), false);
		await Promise.all([coreRun, fullRun]);
		expect(ran).toEqual(['core1', 'core2', 'ui1']);
	});

	test('should start over after a failed run', async () => {
		const { ran, runner, buildTasks } = setUp('ui1');
		await expect(runner(buildTasks(), false)).rejects.toThrow('ui1 failed');
		await runner(buildTasks(), true);
		expect(ran).toEqual(['core1', 'core1', 'core2']);
	});
});

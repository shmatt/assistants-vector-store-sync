import * as core from '@actions/core';
import * as glob from '@actions/glob';
import path from 'path';
import { promises as fs, createReadStream } from 'fs';
import OpenAI, { toFile } from 'openai';
import { simpleGit, SimpleGit } from 'simple-git';
import { createHash } from 'crypto';

import VectorStore = OpenAI.Beta.VectorStore;
import FileObject = OpenAI.FileObject;
import VectorStoreFile = OpenAI.Beta.VectorStores.VectorStoreFile;


function createMD5(filePath: string): Promise<string> {
	return new Promise((res) => {
		const hash = createHash('md5');

		const rStream = createReadStream(filePath);
		rStream.on('data', (data) => {
			hash.update(data);
		});
		rStream.on('end', () => {
			res(hash.digest('hex'));
		});
	})
}

function isSupportedFileType(file: string): boolean {
	const supportedExtensions = ['.c', '.cs', '.cpp', '.doc', '.docx', '.html', '.java', '.json', '.md', '.pdf', '.php', '.pptx', '.py', '.rb', '.tex', '.txt', '.css', '.js', '.sh', '.ts'];
	const ext = path.extname(file);
	if (ext === '') {
		return false;
	}
	return supportedExtensions.includes(ext);
}


/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
	try {
		const pattern = core.getInput('pattern') || '/workspaces/journal/**/*.md';
		const token = core.getInput('token') || process.env.OPENAI_API_KEY;
		const repo = process.env.GITHUB_REPOSITORY;
		const repoName = repo?.split('/')[1];

		let key = core.getInput('key') || repoName;
		if (key == null) {
			const git: SimpleGit = simpleGit();
			const remote = await git.getRemotes(true);
			if (remote.length > 0) {
				key = remote[0].name;
			}
		}

		core.info(`Reading markdown files from ${pattern}`)

		const globber = await glob.create(pattern)

		type FileData = {
			id?: string,
			path?: string,
			keyedPath: string,
			fullPath?: string
		}

		// Create a list of files to add to the OpenAI Organization
		const addFiles: FileData[] = [];
		const addToVectorStoreFiles: FileData[] = [];
		const removeFiles: FileData[] = [];
		const allFiles: FileData[] = [];

		// Load the list of files already added to the OpenAI Organization
		const openai = new OpenAI({ apiKey: token });
		const files = await openai.files.list();

		// Filter this list based on the key
		const keyFiles = files.data.filter((file: FileObject) => file.filename.startsWith(`${key}-`) || file.filename.startsWith(`${key}/`));

		core.info(`Found ${keyFiles.length} matching files in OpenAI Organization`)

		// Get or create the Vector Store
		let vectorStore: VectorStore | undefined;

		let vectorStoresReponse = await openai.beta.vectorStores.list();

		let hasNextPage = false;

		do {
			vectorStore = vectorStoresReponse.data.find((store: VectorStore) => (<any>store.metadata)['key'] == key);
			hasNextPage = vectorStoresReponse.hasNextPage();
			if (vectorStore == null && hasNextPage) {
				vectorStoresReponse = await vectorStoresReponse.getNextPage();
			}
		} while (vectorStore == null && hasNextPage);

		if (vectorStore == null) {
			core.info(`Creating vector store: ${key}`)
			vectorStore = await openai.beta.vectorStores.create({
				name: key,
				metadata: { key: key }
			});
		} else {
			core.info(`Found vector store: ${vectorStore.name} with id: ${vectorStore.id}`)
		}

		// Get the list of files in the Vector Store
		core.info('Getting vector store files')

		let vectorFiles: VectorStoreFile[] = [];
		let vectorFilesResponse = await openai.beta.vectorStores.files.list(vectorStore.id);

		do {
			vectorFiles.push(...vectorFilesResponse.data);
			hasNextPage = vectorFilesResponse.hasNextPage();
			if (hasNextPage) {
				vectorFilesResponse = await vectorFilesResponse.getNextPage();
			}
		} while (hasNextPage);

		core.info(`Found ${vectorFiles.length} files in vector store`)


		for await (const file of globber.globGenerator()) {
			try {
				core.debug(`Found file: ${file}`)

				let data = <FileData>{};

				// Parse the relative path based on the glob pattern
				data.path = path.relative(globber.getSearchPaths()[0], file)
				data.fullPath = file;

				// Create an MD5 hash of the file contents
				let md5 = await createMD5(file);

				data.keyedPath = `${key}-${md5}/${data.path}`

				const existing = keyFiles.find((file: FileObject) => file.filename == data.keyedPath);

				// Get the file size
				const stats = await fs.stat(file);
				const size = stats.size;

				// Ignore empty files
				if (size == 0) {
					core.info(`Ignoring empty file: ${file}`)
					continue;
				}

				// Ignore unsupported file types
				if (!isSupportedFileType(file)) {
					core.info(`Ignoring unsupported file: ${file}`)
					continue;
				}

				if (existing == null) {
					addFiles.push(data);
					core.info(`Adding file: ${file}`)
				} else {

					data.id = existing.id;

					// Check to see if the file is in the vector store
					const vectorFile = vectorFiles.find((file: VectorStoreFile) => file.id == existing.id);

					if (vectorFile == null) {
						addToVectorStoreFiles.push(data);
						core.info(`Adding existing file to vector store: ${file}`)
					}
				}

				allFiles.push(data);

			} catch (error) {
				core.error(`Error processing file: ${file}`)
				if (error instanceof Error) core.error(error.message)
			}
		}

		core.info(`Found ${addFiles.length} files to add to OpenAI Organization`)

		// Create a list of files to remove from the OpenAI Organization
		keyFiles.forEach((file: FileObject) => {
			const data = allFiles.find((f: FileData) => f.keyedPath == file.filename);
			if (data == null && removeFiles.find((f: FileData) => f.keyedPath == file.filename) == null) {
				removeFiles.push({ keyedPath: file.filename, id: file.id });
				core.info(`Removing missing or changed file: ${file.filename}`)
			}
		});

		// Remove any files from the vector store that reference files in the remove list
		let removeFileIds = removeFiles.map((file: FileData) => file.id);
		let removeVectorFilesPromises = removeFileIds
			.map((id: string | undefined) => vectorFiles.find((file: VectorStoreFile) => file.id == id))
			.filter((file: VectorStoreFile | undefined) => file != null)
			.map((file: VectorStoreFile | undefined) => vectorStore?.id && file?.id
				? openai.beta.vectorStores.files.del(vectorStore.id, file.id)
				: Promise.resolve(null)
			);

		if (removeVectorFilesPromises.length > 0) {

			core.info(`Removing ${removeVectorFilesPromises.length} files from vector store`);

			await Promise.all(removeVectorFilesPromises);

			core.info(`Files succesfully removed from vector store`);

		}

		if (removeFiles.length > 0) {

			// Remove files from the remove list
			core.info(`Removing ${removeFiles.length} files from OpenAI Organization`);

			let removeFilesPromises = removeFiles.map((file: FileData) => file.id
				? openai.files.del(file.id)
				: Promise.resolve(null)
			);

			await Promise.all(removeFilesPromises);

			core.info(`Files succesfully removed from OpenAI Organization`);
		}

		if (addFiles.length > 0) {

			// Add files to the vector store that are not already in the vector store
			core.info(`Uploading ${addFiles.length} files to vector store`);

			let uploadablePromises = addFiles
				.filter((file: FileData) => file.fullPath != null)
				.map(async (file: FileData) => {
					return toFile(createReadStream(file.fullPath!), file.keyedPath);
				});

			let uploadables = await Promise.all(uploadablePromises);

			if (uploadables.length > 0) {
				await openai.beta.vectorStores.fileBatches.uploadAndPoll(vectorStore.id, { files: uploadables });
			}

			core.info(`Files succesfully uploaded to vector store`);

		}


		if (addToVectorStoreFiles.length > 0) {

			// Add files to the vector store that have been uploaded already
			core.info(`Adding ${addToVectorStoreFiles.length} files to vector store`);

			addToVectorStoreFiles.forEach((file: FileData) => core.debug(`Adding file: ${file.keyedPath}`));
			await openai.beta.vectorStores.fileBatches.create(vectorStore.id, { file_ids: addToVectorStoreFiles.map((file: FileData) => file.id!) });

			core.info(`Files succesfully added to vector store`);
		}

		core.info("Action complete");

	} catch (error) {
		// Fail the workflow run if an error occurs
		if (error instanceof Error) core.setFailed(error.message)
	}
}

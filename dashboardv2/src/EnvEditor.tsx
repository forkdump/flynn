import * as React from 'react';
import * as jspb from 'google-protobuf';
import fz from 'fz';

import Button from 'grommet/components/Button';
import { CheckmarkIcon, SearchInput } from 'grommet';
import Loading from './Loading';
import protoMapDiff, { DiffOption, applyProtoMapDiff } from './util/protoMapDiff';
import protoMapReplace from './util/protoMapReplace';
import withClient, { ClientProps } from './withClient';
import withErrorHandler, { ErrorHandlerProps } from './withErrorHandler';
import dataStore, { Resource, WatchFunc } from './dataStore';
import { Release } from './generated/controller_pb';

import './EnvEditor.scss';

export type Entries = jspb.Map<string, string>;

function entriesEqual(a: [string, string], b: [string, string]): boolean {
	return a && b && a[0] === b[0] && a[1] === b[1];
}

interface EnvStateInternalState {
	originalEntries: Entries;
	uniqueKeyMap: { [key: string]: number };
	filterText: string;
	deletedIndices: { [key: number]: boolean };
	changedIndices: { [key: number]: boolean };
}

class EnvState {
	public length: number;
	public deletedLength: number;
	public hasChanges: boolean;
	private _entries: Entries;
	private _state: EnvStateInternalState;
	constructor(entries: Entries, state: EnvStateInternalState | null = null) {
		this._entries = entries;
		this._state = state
			? state
			: {
					originalEntries: entries,
					changedIndices: {},
					deletedIndices: {},
					uniqueKeyMap: entries
						.toArray()
						.reduce((m: { [key: string]: number }, [key, value]: [string, string], index: number) => {
							m[key] = index;
							return m;
						}, {}),
					filterText: ''
			  };
		this.length = entries.getLength();
		this._setDeletedLength();
	}

	public dup(): EnvState {
		return new EnvState(this._entries, Object.assign({}, this._state));
	}

	public filtered(filterText: string): EnvState {
		return new EnvState(this._entries, Object.assign({}, this._state, { filterText }));
	}

	public get(key: string): string | undefined {
		return this._entries.get(key);
	}

	public entries(): Entries {
		return new jspb.Map(
			this._entries.toArray().filter(
				(entry: [string, string], index: number): boolean => {
					return this._state.deletedIndices[index] !== true && entry[0] !== '' && entry[1] !== '';
				}
			)
		);
	}

	public map<T>(fn: (entry: [string, string], index: number) => T): T[] {
		const filterText = this._state.filterText;
		return (
			this._entries
				.toArray()
				.reduce<T[]>(
					(prev: T[], entry: [string, string], index: number): T[] => {
						if (this._state.deletedIndices[index] === true) {
							return prev;
						}
						if (filterText && !fz(entry[0], filterText)) {
							return prev;
						}
						return prev.concat(fn(entry, index));
					},
					[] as Array<T>
				)
				// there's always an empty entry at the end for adding new env
				.concat(fn(['', ''], this.length))
		);
	}

	public mapDeleted<T>(fn: (entry: [string, string], index: number) => T): T[] {
		return this._entries.toArray().reduce<T[]>(
			(prev: T[], entry: [string, string], index: number): T[] => {
				if (this._state.deletedIndices[index] !== true) {
					return prev;
				}
				return prev.concat(fn(entry, index));
			},
			[] as Array<T>
		);
	}

	public setKeyAtIndex(index: number, key: string) {
		delete this._state.deletedIndices[index]; // allow restoring an item
		this._setDeletedLength();
		const entries = this._entries.toArray().slice(); // don't modify old map
		entries[index] = [key, (entries[index] || [])[1] || ''];
		this.length = entries.length;
		this._entries = new jspb.Map(entries);
		this._trackChanges(index);
		if (this._state.uniqueKeyMap[key] > -1 && this._state.uniqueKeyMap[key] !== index && index < entries.length) {
			// duplicate key, remove old one
			this.removeEntryAtIndex(this._state.uniqueKeyMap[key]);
			this._state.uniqueKeyMap[key] = index;
		}
	}

	public setValueAtIndex(index: number, val: string) {
		const entries = this._entries.toArray().slice(); // don't modify old map
		entries[index] = [(entries[index] || [])[0] || '', val];
		this.length = entries.length;
		this._entries = new jspb.Map(entries);
		if (val === '' && (entries[index] || [])[0] === '') {
			// if there's no key or value, remove it
			this.removeEntryAtIndex(index);
		} else {
			this._trackChanges(index);
		}
	}

	public removeEntryAtIndex(index: number) {
		this._state.deletedIndices[index] = true;
		this._setDeletedLength();
		this._trackChanges(index);
	}

	private _trackChanges(index: number) {
		const { deletedIndices, changedIndices, originalEntries } = this._state;
		if (deletedIndices[index] === true) {
			if (index < originalEntries.getLength()) {
				changedIndices[index] = true;
			} else {
				delete changedIndices[index];
			}
		} else if (entriesEqual(originalEntries.toArray()[index], this._entries.toArray()[index])) {
			delete changedIndices[index];
		} else {
			changedIndices[index] = true;
		}
		this.hasChanges = Object.keys(changedIndices).length > 0;
	}

	private _setDeletedLength() {
		this.deletedLength = Object.keys(this._state.deletedIndices).length;
	}
}

interface EnvInputProps {
	placeholder: string;
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
}

interface EnvInputState {
	expanded: boolean;
	multiline: boolean;
}

class EnvInput extends React.Component<EnvInputProps, EnvInputState> {
	private _textarea: HTMLTextAreaElement | null;

	constructor(props: EnvInputProps) {
		super(props);
		this.state = {
			expanded: false,
			multiline: props.value.indexOf('\n') >= 0
		};
		this._inputChangeHandler = this._inputChangeHandler.bind(this);
		this._inputFocusHandler = this._inputFocusHandler.bind(this);
		this._textareaBlurHandler = this._textareaBlurHandler.bind(this);
		this._textareaChangeHandler = this._textareaChangeHandler.bind(this);
		this._textarea = null;
	}

	public componentDidUpdate(prevProps: EnvInputProps, prevState: EnvInputState) {
		if (!prevState.expanded && this.state.expanded && this._textarea) {
			this._textarea.focus();
		}
	}

	public render() {
		const { placeholder, value, disabled } = this.props;
		const { expanded } = this.state;
		if (expanded) {
			return (
				<textarea
					value={value}
					onChange={this._textareaChangeHandler}
					onBlur={this._textareaBlurHandler}
					ref={(el) => {
						this._textarea = el;
					}}
				/>
			);
		}
		return (
			<input
				type="text"
				disabled={disabled}
				placeholder={placeholder}
				value={value}
				onChange={this._inputChangeHandler}
				onFocus={this._inputFocusHandler}
			/>
		);
	}

	private _inputChangeHandler(e: React.ChangeEvent<HTMLInputElement>) {
		const value = e.target.value || '';
		this.props.onChange(value);
	}

	private _textareaChangeHandler(e: React.ChangeEvent<HTMLTextAreaElement>) {
		const value = e.target.value || '';
		this.props.onChange(value);
	}

	private _inputFocusHandler() {
		if (this.state.multiline) {
			this.setState({
				expanded: true
			});
		}
	}

	private _textareaBlurHandler() {
		if (this.state.expanded) {
			this.setState({
				expanded: false
			});
		}
	}
}

export interface Props {
	entries: Entries;
	persist: (next: Entries) => void;
	persisting: boolean;
}

interface State {
	entries: EnvState;
	confirming: boolean;
}

class EnvEditor extends React.Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = {
			entries: new EnvState(props.entries),
			confirming: false
		};
		this._searchInputHandler = this._searchInputHandler.bind(this);
		this._submitHandler = this._submitHandler.bind(this);
		this._submitConfirmHandler = this._submitConfirmHandler.bind(this);
	}

	public render() {
		const { persisting } = this.props;
		const { entries, confirming } = this.state;

		if (confirming) {
			return this._renderConfirm();
		}

		return (
			<form onSubmit={this._submitHandler} className="env-editor">
				<SearchInput onDOMChange={this._searchInputHandler} />
				{entries.map(([key, value]: [string, string], index: number) => {
					return (
						<div key={index} className="env-row">
							<EnvInput
								placeholder="ENV key"
								value={key}
								onChange={this._keyChangeHandler.bind(this, index)}
								disabled={persisting}
							/>
							<EnvInput
								placeholder="ENV value"
								value={value}
								onChange={this._valueChangeHandler.bind(this, index)}
								disabled={persisting}
							/>
						</div>
					);
				})}
				{persisting ? (
					// Disable save button with saving indicator
					<Button type="button" primary icon={<CheckmarkIcon />} label="Deploying..." />
				) : entries.hasChanges ? (
					// Enable save button
					<Button type="submit" primary icon={<CheckmarkIcon />} label="Review Changes" />
				) : (
					// Disable save button
					<Button type="button" primary icon={<CheckmarkIcon />} label="Review Changes" />
				)}
			</form>
		);
	}

	private _renderConfirm() {
		const { entries } = this.state;
		const prevEntries = this.props.entries;

		return (
			<form onSubmit={this._submitConfirmHandler} className="env-editor">
				{renderEnvDiff(prevEntries, entries.entries())}
				<Button type="submit" primary icon={<CheckmarkIcon />} label="Deploy" />
				&nbsp;
				<Button
					type="button"
					label="Continue Editing"
					onClick={(e: React.SyntheticEvent) => {
						e.preventDefault();
						this.setState({
							confirming: false
						});
					}}
				/>
			</form>
		);
	}

	private _keyChangeHandler(index: number, key: string) {
		let nextEntries = this.state.entries.dup();
		if (key.length > 0) {
			nextEntries.setKeyAtIndex(index, key);
		} else {
			nextEntries.removeEntryAtIndex(index);
		}
		this.setState({
			entries: nextEntries
		});
	}

	private _valueChangeHandler(index: number, value: string) {
		let nextEntries = this.state.entries.dup();
		nextEntries.setValueAtIndex(index, value);
		this.setState({
			entries: nextEntries
		});
	}

	private _searchInputHandler(e: React.ChangeEvent<HTMLInputElement>) {
		const value = e.target.value || '';
		this.setState({
			entries: this.state.entries.filtered(value)
		});
	}

	private _submitHandler(e: React.SyntheticEvent) {
		e.preventDefault();
		this.setState({
			confirming: true
		});
	}

	private _submitConfirmHandler(e: React.SyntheticEvent) {
		e.preventDefault();
		this.setState({
			confirming: false
		});
		this.props.persist(this.state.entries.entries());
	}
}

export function renderEnvDiff(prevEnv: Entries, env: Entries) {
	const diff = protoMapDiff(prevEnv, env, DiffOption.INCLUDE_UNCHANGED).sort((a, b) => {
		return a.key.localeCompare(b.key);
	});

	return (
		<pre>
			{diff.map((item) => {
				let value;
				let prefix = ' ';
				switch (item.op) {
					case 'keep':
						value = env.get(item.key);
						break;
					case 'remove':
						prefix = '-';
						value = prevEnv.get(item.key);
						break;
					case 'add':
						prefix = '+';
						value = env.get(item.key);
						break;
				}
				return (
					<span key={item.op + item.key} className={'env-diff-' + item.op}>
						{prefix} {item.key} = {value}
						<br />
					</span>
				);
			})}
		</pre>
	);
}

interface WrappedProps extends ClientProps, ErrorHandlerProps {
	appName: string;
}

interface WrappedState {
	release: Release | null;
	isLoading: boolean;
	isPersisting: boolean;
}

class WrappedEnvEditor extends React.Component<WrappedProps, WrappedState> {
	private _dataWatcher: WatchFunc | null;
	constructor(props: WrappedProps) {
		super(props);
		this.state = {
			release: null,
			isLoading: true,
			isPersisting: false
		};

		this._dataWatcher = null;
		this._getData = this._getData.bind(this);
		this._envPersistHandler = this._envPersistHandler.bind(this);
	}

	public componentDidMount() {
		this._getData();
	}

	public componentWillUnmount() {
		this._unwatchData();
	}

	public render() {
		const { release, isPersisting, isLoading } = this.state;
		if (isLoading) {
			return <Loading />;
		}
		if (!release) throw new Error('Unexpected lack of release!');
		return <EnvEditor entries={release.getEnvMap()} persist={this._envPersistHandler} persisting={isPersisting} />;
	}

	private _watchData(releaseName: string) {
		const watcher = (this._dataWatcher = dataStore.watch(releaseName));
		watcher((name: string, r: Resource | undefined) => {
			if (!r) {
				return;
			}
			this.setState({
				release: r as Release
			});
		});
	}

	private _unwatchData() {
		if (!this._dataWatcher) return;
		this._dataWatcher.unsubscribe();
	}

	private _getData() {
		const { client, appName, handleError } = this.props;
		this.setState({
			release: null,
			isLoading: true,
			isPersisting: false
		});
		this._unwatchData();
		client
			.getAppRelease(appName)
			.then((release) => {
				this._watchData(release.getName());

				this.setState({
					release,
					isLoading: false,
					isPersisting: false
				});
			})
			.catch((error: Error) => {
				this.setState({
					release: null,
					isLoading: false,
					isPersisting: false
				});
				handleError(error);
			});
	}

	private _envPersistHandler(next: jspb.Map<string, string>) {
		const { client, appName, handleError } = this.props;
		const { release } = this.state;
		if (!release) throw new Error('Unexpected lack of release!');
		const envDiff = protoMapDiff(release.getEnvMap(), next);
		this.setState({
			isLoading: false,
			isPersisting: true
		});
		const prevReleaseName = release.getName();
		this._unwatchData();
		client
			.getAppRelease(appName)
			.then((release) => {
				const newRelease = new Release();
				newRelease.setArtifactsList(release.getArtifactsList());
				protoMapReplace(newRelease.getLabelsMap(), release.getLabelsMap());
				protoMapReplace(newRelease.getProcessesMap(), release.getProcessesMap());
				protoMapReplace(newRelease.getEnvMap(), applyProtoMapDiff(release.getEnvMap(), envDiff));
				return client.createRelease(appName, newRelease);
			})
			.then((release) => {
				this._watchData(release.getName());
				return client
					.createDeployment(appName, release.getName())
					.then((deployment) => {
						this.setState({
							isPersisting: false
						});
					})
					.then(() => {
						dataStore.del(prevReleaseName);
						return client.getApp(appName).then((app) => {
							dataStore.add(app);
						});
					});
			})
			.catch((error: Error) => {
				this.setState({
					isPersisting: false
				});
				handleError(error);
			});
	}
}

export default withErrorHandler(withClient(WrappedEnvEditor));

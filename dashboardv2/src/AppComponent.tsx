import * as React from 'react';
import Heading from 'grommet/components/Heading';
import Accordion from 'grommet/components/Accordion';
import AccordionPanel from 'grommet/components/AccordionPanel';

import dataStore, { Resource, WatchFunc } from './dataStore';
import withClient, { ClientProps } from './withClient';
import withErrorHandler, { ErrorHandlerProps } from './withErrorHandler';
import { App } from './generated/controller_pb';
import Loading from './Loading';
import ReleaseHistory from './ReleaseHistory';
const EnvEditor = React.lazy(() => import('./EnvEditor'));

export interface Props extends ClientProps, ErrorHandlerProps {
	name: string;
}

interface State {
	app: App | null;
	releaseDeploying: boolean;
}

class AppComponent extends React.Component<Props, State> {
	private __dataWatcher: WatchFunc;
	constructor(props: Props) {
		super(props);
		this.state = {
			app: null,
			releaseDeploying: false
		};
		this._deployReleaseHandler = this._deployReleaseHandler.bind(this);
		this._handleDataChange = this._handleDataChange.bind(this);
	}

	public componentDidMount() {
		const appName = this.props.name;

		// watch for changes on app and all sub resources (e.g. release)
		this.__dataWatcher = dataStore.watch(appName)(this._handleDataChange);

		// fetch app and release
		this._getData(true);
	}

	public componentWillUnmount() {
		this.__dataWatcher.unsubscribe();
	}

	public render() {
		const { app } = this.state;

		if (!app) {
			return <Loading />;
		}

		const { releaseDeploying } = this.state;
		return (
			<React.Fragment>
				<Heading>{app.getDisplayName()}</Heading>
				<Accordion openMulti={true} animate={false} active={0}>
					<AccordionPanel heading="Release History">
						<ReleaseHistory
							appName={app.getName()}
							currentReleaseName={app.getRelease()}
							persisting={releaseDeploying}
							persist={this._deployReleaseHandler}
						/>
					</AccordionPanel>

					<AccordionPanel heading="Environment">
						<React.Suspense fallback={<Loading />}>
							<EnvEditor key={app.getRelease()} appName={app.getName()} />
						</React.Suspense>
					</AccordionPanel>
				</Accordion>
			</React.Fragment>
		);
	}

	private _handleDataChange(name: string, resource: Resource | undefined) {
		this._getData();
	}

	private _getData(shouldFetch: boolean = false) {
		// populate app and release from dataStore if available
		const appName = this.props.name;
		const app = dataStore.get(appName) as App | null;
		this.setState({
			app: app
		});

		// conditionally fetch app and/or release
		const { client, handleError } = this.props;
		if (shouldFetch || !app) {
			client.getApp(appName).catch(handleError);
		}
	}

	private _deployReleaseHandler(releaseName: string) {
		const { client, handleError } = this.props;
		const { app } = this.state;
		if (!app) return;
		this.setState({
			releaseDeploying: true
		});
		client
			.createDeployment(app.getName(), releaseName)
			.then(() => {
				return client.getApp(app.getName());
			})
			.then(() => {
				this.setState({
					releaseDeploying: false
				});
			})
			.catch((error: Error) => {
				this.setState({
					releaseDeploying: false
				});
				handleError(error);
			});
	}
}
export default withErrorHandler(withClient(AppComponent));

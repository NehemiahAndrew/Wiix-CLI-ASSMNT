import React, { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { WixDesignSystemProvider, Box, Heading, Text } from '@wix/design-system';
import '@wix/design-system/styles.global.css';
import App from '../../../client/App';

/* ── Simple Error Boundary ── */
interface EBState { error: Error | null }
class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[DashboardPage] React error:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <Box direction="vertical" gap="12px" padding="24px">
          <Heading size="medium">Something went wrong</Heading>
          <Text>{this.state.error.message}</Text>
          <Text size="small" secondary>
            {this.state.error.stack?.split('\n').slice(0, 5).join('\n')}
          </Text>
        </Box>
      );
    }
    return this.props.children;
  }
}

const DashboardPage: React.FC = () => {
  return (
    <WixDesignSystemProvider features={{ newColorsBranding: true }}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </WixDesignSystemProvider>
  );
};

export default DashboardPage;

import { Component, type ReactNode } from "react";

interface FeatureErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

interface FeatureErrorBoundaryState {
  failed: boolean;
}

export class FeatureErrorBoundary extends Component<
  FeatureErrorBoundaryProps,
  FeatureErrorBoundaryState
> {
  state: FeatureErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): FeatureErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch() {
    // Feature failures stay local and exception details never reach the UI.
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

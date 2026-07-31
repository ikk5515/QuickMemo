import { Component, Fragment, type ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
  retryKey: number;
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    failed: false,
    retryKey: 0
  };

  static getDerivedStateFromError(): Partial<AppErrorBoundaryState> {
    return { failed: true };
  }

  componentDidCatch() {
    // The fallback deliberately does not expose exception messages or stacks.
    // Provider-specific monitoring can be added here without rendering PII.
  }

  private retry = () => {
    this.setState((current) => ({
      failed: false,
      retryKey: current.retryKey + 1
    }));
  };

  render() {
    if (this.state.failed) {
      return (
        <main className="page-center app-loading-page">
          <section aria-labelledby="app-error-title" className="loading-card" role="alert">
            <h1 id="app-error-title">화면을 불러오지 못했습니다</h1>
            <p>잠시 후 다시 시도해주세요. 입력한 비밀 정보는 오류 화면에 표시되지 않습니다.</p>
            <button className="secondary-button" onClick={this.retry} type="button">
              다시 시도
            </button>
            <button
              className="secondary-button"
              onClick={() => window.location.reload()}
              type="button"
            >
              페이지 새로고침
            </button>
          </section>
        </main>
      );
    }

    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
}

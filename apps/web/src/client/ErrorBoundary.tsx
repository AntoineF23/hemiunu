// A render crash in any child (e.g. odd markdown, an unexpected message shape)
// should NOT blank the whole app. This catches it and shows a fallback instead.
// React error boundaries must be class components — there is no hook equivalent.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Fallback to render when a child throws. A function gets the error. */
  fallback?: ReactNode | ((error: Error) => ReactNode);
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface in the console for debugging; the UI stays usable.
    console.error("Render error caught by boundary:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === "function") return fallback(error);
    if (fallback !== undefined) return fallback;
    return (
      <div className="error-boundary" role="alert">
        Something went wrong displaying this. The rest of the app is still working.
      </div>
    );
  }
}

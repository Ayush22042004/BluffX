import React, { lazy, Suspense } from "react";
const Tutorial = lazy(() => import("./TutorialGame"));
const Circle = lazy(() => import("./Community"));
function Loading() {
  return (
    <p role="status" className="screen-loading">
      Loading…
    </p>
  );
}
export function TutorialGame(props) {
  return (
    <Suspense fallback={<Loading />}>
      <Tutorial {...props} />
    </Suspense>
  );
}
export function Community(props) {
  return (
    <Suspense fallback={<Loading />}>
      <Circle {...props} />
    </Suspense>
  );
}

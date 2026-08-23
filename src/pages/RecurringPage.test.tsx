import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import RecurringPage from "./RecurringPage";

function LocationProbe() {
  const location = useLocation();

  return <span data-testid="location">{location.pathname}{location.search}</span>;
}

describe("RecurringPage", () => {
  it("canonicalizes the legacy recurring route to the calendar view", () => {
    render(
      <MemoryRouter initialEntries={["/schedule/recurring"]}>
        <LocationProbe />
        <Routes>
          <Route path="/schedule/recurring" element={<RecurringPage />} />
          <Route path="/schedule" element={<span>일정 화면</span>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("일정 화면")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/schedule?view=calendar");
  });
});

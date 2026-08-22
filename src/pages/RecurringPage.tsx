import { Navigate } from "react-router-dom";

export default function RecurringPage() {
  return <Navigate to="/schedule?view=calendar" replace />;
}

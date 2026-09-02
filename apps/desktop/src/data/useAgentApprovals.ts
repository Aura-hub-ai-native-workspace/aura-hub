/**
 * Agent Approvals hook — bridges the Central Agent's approval ledger.
 * ==================================================================
 * The Central Agent maintains its own approval ledger (on :4320) separate
 * from the Workflow service's Fabric ledger (on :4319). This hook
 * provides access to the Agent's pending approvals.
 */

import { useEffect, useState } from 'react';
import { centralAgentClient } from '../ai/centralAgentClient';

interface UseAgentApprovalsReturn {
  approvals: any[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useAgentApprovals(): UseAgentApprovalsReturn {
  const [approvals, setApprovals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchApprovals = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await centralAgentClient.pendingApprovals();
      setApprovals(response.approvals || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals');
      setApprovals([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApprovals();
    // Poll for updates while there are pending approvals
    const interval = setInterval(fetchApprovals, 5000);
    return () => clearInterval(interval);
  }, []);

  return { approvals, loading, error, refetch: fetchApprovals };
}


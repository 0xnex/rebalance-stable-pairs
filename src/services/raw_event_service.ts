import sql from "../config/database.js";

export interface RawEvent {
  id: number;
  pool_address: string;
  tx_id: string;
  event_name: string;
  timestamp_ms: number;
  data: any; // JSON data
  code: string;
  num_of_events: number;
  timestamp: Date;
  is_desc: boolean;
}

export interface GetEventsParams {
  poolAddress: string;
  limit?: number;
  offset?: number;
  startTime?: number;
  endTime?: number;
}

export class RawEventService {
  /**
   * Get events with optional time range and pagination
   */
  async getEvents(params: GetEventsParams): Promise<RawEvent[]> {
    const { poolAddress, startTime, endTime, limit = 100, offset = 0 } = params;

    // Build WHERE clause and values array
    const where: string[] = ["pool_address = $1"];
    const values: any[] = [poolAddress];
    let paramIdx = 2;
    if (typeof startTime === "number") {
      where.push(`timestamp_ms >= $${paramIdx}`);
      values.push(startTime);
      paramIdx++;
    }
    if (typeof endTime === "number") {
      where.push(`timestamp_ms <= $${paramIdx}`);
      values.push(endTime);
      paramIdx++;
    }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sqlText = `SELECT * FROM raw_events ${whereClause} ORDER BY timestamp_ms ASC LIMIT $${paramIdx} OFFSET $${
      paramIdx + 1
    }`;
    values.push(limit, offset);
    const result = await sql.unsafe(sqlText, values);
    return result as unknown as RawEvent[];
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await sql.end();
  }
}

// Export singleton instance
export const rawEventService = new RawEventService();

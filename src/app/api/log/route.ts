import { NextResponse } from 'next/server'
import { db } from '../../../server/db'

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`
    console.log('Database connection test successful')
    return NextResponse.json({ status: 'Database connection successful' }, { status: 200 })
  } catch (error) {
    console.error('Database connection test failed:', error)
    return NextResponse.json(
      { 
        status: 'Database connection failed', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, 
      { status: 500 }
    )
  }
}

